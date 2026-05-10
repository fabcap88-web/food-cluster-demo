import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TimeoutService } from '../timeouts/timeout.service';

export type MerchantStatusUpdate = 'PREPARING' | 'READY' | 'HANDED_OFF' | 'CANCELLED';

@Injectable()
export class SubOrderService {
  private readonly logger = new Logger(SubOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly realtime: RealtimeService,
    private readonly timeoutService: TimeoutService,
  ) {}

  async getMerchantOrders(brandId: string) {
    const orders = await this.prisma.subOrder.findMany({
      where: {
        brandId,
        status: { in: ['PENDING', 'PENDING_TIMEOUT', 'ACCEPTED_WAITING_GROUP', 'ACCEPTED', 'PREPARING', 'READY'] },
      },
      include: {
        brand: true,
        items: true,
        masterOrder: { include: { captainBrand: true, subOrders: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      orders: orders.map((order) => ({
        subOrderId: order.id,
        masterOrderId: order.masterOrderId,
        orderNumber: order.masterOrder.orderNumber,
        brandId: order.brandId,
        brandName: order.brand.name,
        status: order.status,
        subtotalCents: order.subtotalCents,
        customerNotes: order.masterOrder.customerNotes ?? undefined,
        isPartOfMultiBrandOrder: order.masterOrder.subOrders.length > 1,
        captainBrandName: order.masterOrder.captainBrand?.name,
        items: order.items.map((item) => ({
          name: item.nameSnapshot,
          quantity: item.quantity,
          notes: item.notes ?? undefined,
        })),
        createdAt: order.createdAt.toISOString(),
      })),
    };
  }

  async acceptSubOrder(subOrderId: string, merchantBrandId: string, prepEtaMinutes: number) {
    this.validateEta(prepEtaMinutes);

    // Cancel timeout BEFORE the transaction.
    // Previously this ran inside the tx on Serializable isolation, causing
    // P2034 (write conflict) on Neon serverless because BullMQ's Redis call
    // extended the tx duration unpredictably. Now it's outside the tx entirely.
    await this.timeoutService.cancelMerchantTimeout(subOrderId).catch((err) => {
      // Non-fatal: if Redis/timer cancel fails, the sub-order accept still proceeds.
      this.logger.warn(`[accept] cancelMerchantTimeout failed (non-fatal): ${err?.message}`);
    });

    // Use ReadCommitted (Prisma default) instead of Serializable.
    // Serializable caused P2034 write-conflict retries on Neon's serverless
    // connection pooler and was unnecessary: the optimistic status-check
    // (only PENDING/PENDING_TIMEOUT allowed) provides sufficient guard.
    const result = await this.prisma.$transaction(async (tx) => {
      const subOrder = await tx.subOrder.findFirst({
        where: { id: subOrderId, brandId: merchantBrandId },
        include: { masterOrder: true },
      });

      if (!subOrder) throw new NotFoundException('Sub-order not found');
      if (!['PENDING', 'PENDING_TIMEOUT'].includes(subOrder.status)) {
        throw new BadRequestException('Only pending sub-orders can be accepted');
      }

      const wasTimedOut = subOrder.status === 'PENDING_TIMEOUT';

      const updated = await tx.subOrder.update({
        where: { id: subOrderId },
        data: { status: 'ACCEPTED_WAITING_GROUP', prepEtaMinutes, acceptedAt: new Date() },
      });

      if (wasTimedOut) {
        await tx.adminAuditLog.create({
          data: {
            action: 'TIMEOUT_OVERRIDE_BY_MERCHANT',
            entityType: 'SubOrder',
            entityId: subOrderId,
            metadata: { brandId: merchantBrandId, masterOrderId: updated.masterOrderId },
          },
        });
      }

      const allSubOrders = await tx.subOrder.findMany({
        where: { masterOrderId: updated.masterOrderId },
      });

      const allAccepted = allSubOrders.every((s) =>
        s.id === updated.id
          ? true
          : ['ACCEPTED_WAITING_GROUP', 'ACCEPTED'].includes(s.status),
      );

      if (allAccepted) {
        await tx.subOrder.updateMany({
          where: { masterOrderId: updated.masterOrderId, status: 'ACCEPTED_WAITING_GROUP' },
          data: { status: 'ACCEPTED' },
        });
        await tx.masterOrder.update({
          where: { id: updated.masterOrderId },
          data: { status: 'ACCEPTED' },
        });
      } else {
        await tx.masterOrder.update({
          where: { id: updated.masterOrderId },
          data: { status: 'PARTIALLY_ACCEPTED' },
        });
      }

      return {
        updated,
        masterOrderStatus: allAccepted ? 'ACCEPTED' : 'PARTIALLY_ACCEPTED',
        customerId: subOrder.masterOrder.customerId,
      };
    });

    const payload = {
      masterOrderId: result.updated.masterOrderId,
      subOrderId: result.updated.id,
      brandId: result.updated.brandId,
      status: result.updated.status,
      prepEtaMinutes,
      masterOrderStatus: result.masterOrderStatus,
    };

    // Emit to all relevant parties so customer tracking updates immediately
    this.realtime.emitToAdmins('SUB_ORDER_STATUS_UPDATED', payload);
    this.realtime.emitToMerchant(result.updated.brandId, 'SUB_ORDER_STATUS_UPDATED', payload);
    this.realtime.emitToCustomer(result.customerId, 'SUB_ORDER_STATUS_UPDATED', payload);

    return {
      subOrderId: result.updated.id,
      status: result.updated.status,
      prepEtaMinutes: result.updated.prepEtaMinutes,
      masterOrderStatus: result.masterOrderStatus,
    };
  }

  async rejectSubOrder(subOrderId: string, merchantBrandId: string, reason: string) {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('Reject reason is required');
    }

    // Cancel timeout outside the transaction (same rationale as accept)
    await this.timeoutService.cancelMerchantTimeout(subOrderId).catch((err) => {
      this.logger.warn(`[reject] cancelMerchantTimeout failed (non-fatal): ${err?.message}`);
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const subOrder = await tx.subOrder.findFirst({
        where: { id: subOrderId, brandId: merchantBrandId },
        include: { masterOrder: true },
      });

      if (!subOrder) throw new NotFoundException('Sub-order not found');
      if (
        !['PENDING', 'PENDING_TIMEOUT', 'ACCEPTED_WAITING_GROUP', 'ACCEPTED'].includes(
          subOrder.status,
        )
      ) {
        throw new BadRequestException('This sub-order can no longer be rejected');
      }

      const updated = await tx.subOrder.update({
        where: { id: subOrderId },
        data: { status: 'REJECTED', rejectedReason: reason },
      });

      const allSubOrders = await tx.subOrder.findMany({
        where: { masterOrderId: updated.masterOrderId },
      });

      const allTerminal = allSubOrders.every((s) =>
        ['REJECTED', 'CANCELLED', 'PENDING_TIMEOUT'].includes(s.status),
      );

      const nextMasterStatus = allTerminal ? 'CANCELLED' : 'CUSTOMER_DECISION_REQUIRED';

      if (allTerminal) {
        await tx.masterOrder.update({
          where: { id: updated.masterOrderId },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
      } else {
        await tx.masterOrder.update({
          where: { id: updated.masterOrderId },
          data: { status: 'CUSTOMER_DECISION_REQUIRED' },
        });
      }

      return {
        updated,
        customerId: subOrder.masterOrder.customerId,
        masterOrderStatus: nextMasterStatus,
      };
    });

    const payload = {
      masterOrderId: result.updated.masterOrderId,
      subOrderId: result.updated.id,
      brandId: result.updated.brandId,
      status: result.updated.status,
      reason,
      masterOrderStatus: result.masterOrderStatus,
    };

    this.realtime.emitToAdmins('SUB_ORDER_REJECTED', payload);
    // FIX: original code was missing emitToCustomer on reject → tracking page
    // never updated when a merchant rejected. Added here.
    this.realtime.emitToCustomer(result.customerId, 'SUB_ORDER_REJECTED', payload);

    if (result.masterOrderStatus === 'CUSTOMER_DECISION_REQUIRED') {
      // Non-fatal: if scheduling fails (Redis down), the customer can still
      // see the CUSTOMER_DECISION_REQUIRED status via polling fallback.
      await this.timeoutService
        .scheduleCustomerDecisionTimeout(result.updated.masterOrderId)
        .catch((err) => {
          this.logger.warn(`[reject] scheduleCustomerDecisionTimeout failed (non-fatal): ${err?.message}`);
        });
    }

    return {
      subOrderId: result.updated.id,
      status: result.updated.status,
      masterOrderStatus: result.masterOrderStatus,
    };
  }

  async updateStatus(subOrderId: string, merchantBrandId: string, status: MerchantStatusUpdate) {
    const result = await this.prisma.$transaction(async (tx) => {
      const subOrder = await tx.subOrder.findFirst({
        where: { id: subOrderId, brandId: merchantBrandId },
        include: { masterOrder: true },
      });

      if (!subOrder) throw new NotFoundException('Sub-order not found');

      const terminalMasterStates = ['CANCELLED', 'DELIVERED', 'DISPUTED_REVIEW'];
      if (terminalMasterStates.includes(subOrder.masterOrder.status)) {
        throw new BadRequestException(
          `Cannot update sub-order for master status ${subOrder.masterOrder.status}`,
        );
      }

      this.validateStatusTransition(subOrder.status, status);

      const data: Record<string, unknown> = { status };
      if (status === 'READY') data.readyAt = new Date();
      if (status === 'HANDED_OFF') data.handedOffAt = new Date();

      return tx.subOrder.update({ where: { id: subOrderId }, data });
    });

    const masterOrderStatus = await this.ordersService.recalculateMasterStatus(result.masterOrderId);

    // Fetch customerId for customer-facing realtime update
    const masterOrder = await this.prisma.masterOrder.findUnique({
      where: { id: result.masterOrderId },
      select: { customerId: true },
    });

    const payload = {
      masterOrderId: result.masterOrderId,
      subOrderId: result.id,
      brandId: result.brandId,
      status: result.status,
      masterOrderStatus,
    };

    this.realtime.emitToAdmins('SUB_ORDER_STATUS_UPDATED', payload);
    this.realtime.emitToMerchant(result.brandId, 'SUB_ORDER_STATUS_UPDATED', payload);
    // FIX: customer was not being notified on status progression (PREPARING/READY/HANDED_OFF)
    if (masterOrder?.customerId) {
      this.realtime.emitToCustomer(masterOrder.customerId, 'SUB_ORDER_STATUS_UPDATED', payload);
    }

    return { subOrderId: result.id, status: result.status, masterOrderStatus };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private validateEta(minutes: number) {
    if (![5, 10, 15, 20, 25, 30].includes(minutes)) {
      throw new BadRequestException('Invalid preparation ETA');
    }
  }

  private validateStatusTransition(current: string, next: MerchantStatusUpdate) {
    const allowed: Record<string, MerchantStatusUpdate[]> = {
      PENDING: ['CANCELLED'],
      PENDING_TIMEOUT: ['CANCELLED'],
      ACCEPTED_WAITING_GROUP: ['CANCELLED'],
      ACCEPTED: ['PREPARING', 'READY', 'CANCELLED'],
      PREPARING: ['READY', 'CANCELLED'],
      READY: ['HANDED_OFF'],
      HANDED_OFF: [],
      REJECTED: [],
      CANCELLED: [],
    };
    if (!allowed[current]?.includes(next)) {
      throw new BadRequestException(`Invalid transition from ${current} to ${next}`);
    }
  }
}
