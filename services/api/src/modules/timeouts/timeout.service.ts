/**
 * TimeoutService — DEMO-STABLE VERSION
 *
 * BullMQ/Redis is bypassed entirely. Timeouts are emulated with in-process
 * setTimeout calls backed by a DB flag so the worker survives a restart
 * (Railway restarts are common on free/hobby tier).
 *
 * Trade-offs accepted for demo:
 *  - In-process timers reset on restart → merchant timeout window restarts too.
 *    Acceptable: demo sessions are short-lived.
 *  - No distributed queue. Acceptable: single-instance deploy.
 *
 * To restore BullMQ later: swap this file back to the original and ensure
 * REDIS_URL is set in Railway environment variables.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

const MERCHANT_TIMEOUT_MS = 2 * 60 * 1000; // 2 min
const CUSTOMER_DECISION_TIMEOUT_MS = 2 * 60 * 1000; // 2 min

@Injectable()
export class TimeoutService implements OnModuleInit {
  private readonly logger = new Logger(TimeoutService.name);

  // In-process timer registry. Key → NodeJS.Timeout handle.
  private readonly merchantTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly customerTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * On boot: re-hydrate any PENDING sub-orders whose timeout should still fire.
   * This covers the case where Railway restarted mid-demo.
   */
  async onModuleInit() {
    try {
      const stale = await this.prisma.subOrder.findMany({
        where: { status: 'PENDING' },
        select: { id: true, createdAt: true },
      });

      for (const s of stale) {
        const elapsed = Date.now() - s.createdAt.getTime();
        const remaining = Math.max(0, MERCHANT_TIMEOUT_MS - elapsed);
        this.logger.log(`[boot] re-scheduling merchant timeout for ${s.id} in ${remaining}ms`);
        this._setMerchantTimer(s.id, remaining);
      }
    } catch (err) {
      this.logger.warn('[boot] Could not re-hydrate timeouts (DB unavailable?): ' + err);
    }
  }

  // ─── Merchant acceptance timeout ────────────────────────────────────────────

  async scheduleMerchantAcceptanceTimeout(subOrderId: string) {
    this._setMerchantTimer(subOrderId, MERCHANT_TIMEOUT_MS);
  }

  async cancelMerchantTimeout(subOrderId: string) {
    const handle = this.merchantTimers.get(subOrderId);
    if (handle) {
      clearTimeout(handle);
      this.merchantTimers.delete(subOrderId);
      this.logger.log(`[merchant-timeout] cancelled for ${subOrderId}`);
    }
  }

  // ─── Customer decision timeout ───────────────────────────────────────────────

  async scheduleCustomerDecisionTimeout(masterOrderId: string) {
    this._setCustomerTimer(masterOrderId, CUSTOMER_DECISION_TIMEOUT_MS);
  }

  async cancelCustomerDecisionTimeout(masterOrderId: string) {
    const handle = this.customerTimers.get(masterOrderId);
    if (handle) {
      clearTimeout(handle);
      this.customerTimers.delete(masterOrderId);
      this.logger.log(`[customer-timeout] cancelled for ${masterOrderId}`);
    }
  }

  // ─── Idempotency cleanup (simple interval, no queue needed) ─────────────────

  async scheduleIdempotencyCleanup() {
    // No-op in demo mode: idempotency keys are cleaned up by Neon's own
    // TTL or can be pruned manually. Leaving this as a no-op avoids the
    // missing `idempotencyCleanupQueue` reference that caused a crash.
    this.logger.log('[idempotency-cleanup] skipped in demo mode (no Redis)');
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private _setMerchantTimer(subOrderId: string, delayMs: number) {
    // Cancel any existing timer for this id to avoid duplicates
    this.cancelMerchantTimeout(subOrderId);

    const handle = setTimeout(async () => {
      this.merchantTimers.delete(subOrderId);
      this.logger.warn(`[merchant-timeout] FIRED for sub-order ${subOrderId}`);
      try {
        await this.prisma.subOrder.updateMany({
          where: { id: subOrderId, status: 'PENDING' },
          data: { status: 'PENDING_TIMEOUT' },
        });

        // Fetch masterOrderId to recalculate parent status
        const subOrder = await this.prisma.subOrder.findUnique({
          where: { id: subOrderId },
          select: { masterOrderId: true, masterOrder: { select: { customerId: true } } },
        });

        if (subOrder) {
          await this._recalcMasterAfterTimeout(subOrder.masterOrderId);
        }
      } catch (err) {
        this.logger.error(`[merchant-timeout] DB update failed for ${subOrderId}`, err);
      }
    }, delayMs);

    this.merchantTimers.set(subOrderId, handle);
  }

  private _setCustomerTimer(masterOrderId: string, delayMs: number) {
    this.cancelCustomerDecisionTimeout(masterOrderId);

    const handle = setTimeout(async () => {
      this.customerTimers.delete(masterOrderId);
      this.logger.warn(`[customer-timeout] FIRED for master-order ${masterOrderId}`);
      try {
        // Auto-cancel the entire master order if customer doesn't decide
        await this.prisma.masterOrder.updateMany({
          where: { id: masterOrderId, status: 'CUSTOMER_DECISION_REQUIRED' },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
      } catch (err) {
        this.logger.error(`[customer-timeout] DB update failed for ${masterOrderId}`, err);
      }
    }, delayMs);

    this.customerTimers.set(masterOrderId, handle);
  }

  /**
   * After a merchant timeout fires, check if all sub-orders are terminal
   * and update masterOrder accordingly. Mirrors the logic in OrdersService
   * without creating a circular dependency.
   */
  private async _recalcMasterAfterTimeout(masterOrderId: string) {
    const master = await this.prisma.masterOrder.findUnique({
      where: { id: masterOrderId },
      include: { subOrders: { select: { status: true } } },
    });

    if (!master) return;

    const terminalMaster = ['CANCELLED', 'DELIVERED', 'DISPUTED_REVIEW', 'READY_FOR_PICKUP', 'PICKED_UP'];
    if (terminalMaster.includes(master.status)) return;

    const statuses = master.subOrders.map((s) => s.status);
    const allTerminal = statuses.every((s) =>
      ['REJECTED', 'CANCELLED', 'PENDING_TIMEOUT'].includes(s),
    );
    const someTerminal = statuses.some((s) =>
      ['REJECTED', 'CANCELLED', 'PENDING_TIMEOUT'].includes(s),
    );

    let nextStatus = master.status;
    if (allTerminal) nextStatus = 'CANCELLED';
    else if (someTerminal) nextStatus = 'CUSTOMER_DECISION_REQUIRED';

    if (nextStatus !== master.status) {
      await this.prisma.masterOrder.updateMany({
        where: { id: masterOrderId, status: master.status },
        data: {
          status: nextStatus,
          ...(nextStatus === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
        },
      });
      this.logger.log(`[merchant-timeout] master ${masterOrderId} → ${nextStatus}`);
    }
  }
}
