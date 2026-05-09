import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TimeoutService } from '../timeouts/timeout.service';

@Injectable()
export class ResolutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly realtime: RealtimeService,
    private readonly timeoutService: TimeoutService,
  ) {}

  async liveOrders() {
    return this.prisma.masterOrder.findMany({
      where: { status: { in: ['WAITING_MERCHANT_ACCEPTANCE', 'PARTIALLY_ACCEPTED', 'ACCEPTED', 'PREPARING', 'CUSTOMER_DECISION_REQUIRED', 'RESOLUTION_REQUIRED'] } },
      include: { subOrders: { include: { brand: true } }, captainBrand: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }


  async cancelAll(masterOrderId: string, actorId?: string) {
    await this.timeoutService.cancelCustomerDecisionTimeout(masterOrderId);

    const result = await this.prisma.$transaction(async (tx) => {
      const order = await tx.masterOrder.findUnique({ where: { id: masterOrderId }, include: { deliveryTask: true } });
      if (!order) throw new NotFoundException('Order not found');

      if (order.status === 'CANCELLED') {
        return { status: 'CANCELLED' as const, idempotentReplay: true };
      }

      if (order.status === 'DISPUTED_REVIEW') {
        return { status: 'DISPUTED_REVIEW' as const, idempotentReplay: true };
      }

      const deliveryStarted = ['ASSIGNED', 'PICKING_UP', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(order.deliveryTask?.status ?? '');

      if (deliveryStarted) {
        await tx.masterOrder.update({ where: { id: masterOrderId }, data: { status: 'DISPUTED_REVIEW' } });
        await tx.adminAuditLog.create({ data: { actorId, action: 'MOVE_TO_DISPUTED_REVIEW', entityType: 'MasterOrder', entityId: masterOrderId, metadata: { reason: 'cancel_requested_after_delivery_started' } } });
        return { status: 'DISPUTED_REVIEW' as const };
      }

      await tx.subOrder.updateMany({ where: { masterOrderId }, data: { status: 'CANCELLED' } });
      await tx.masterOrder.update({ where: { id: masterOrderId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await this.ledger.reverseOrderEntriesTx(tx, masterOrderId, { reverseDeliveryFee: true });

      if (order.paymentMethod === 'CREDIT') {
        const existingRefund = await tx.creditEntry.findFirst({
          where: { masterOrderId: order.id, type: 'REFUND', amountCents: order.totalCents },
        });

        if (!existingRefund) {
          await tx.customer.update({
            where: { id: order.customerId },
            data: { creditBalanceCents: { increment: order.totalCents } },
          });
          await tx.creditEntry.create({
            data: {
              customerId: order.customerId,
              masterOrderId: order.id,
              amountCents: order.totalCents,
              type: 'REFUND',
              description: `Refund for cancelled order #${order.orderNumber}`,
            },
          });
        }
      }

      await tx.adminAuditLog.create({ data: { actorId, action: 'CANCEL_ALL', entityType: 'MasterOrder', entityId: masterOrderId, metadata: {} } });

      return { status: 'CANCELLED' as const };
    });

    this.realtime.emitToAdmins('ORDER_RESOLUTION_UPDATED', { masterOrderId, status: result.status });
    return result;
  }

  async continuePartial(masterOrderId: string, actorId?: string) {
    await this.timeoutService.cancelCustomerDecisionTimeout(masterOrderId);

    const result = await this.prisma.$transaction(async (tx) => {
      const order = await tx.masterOrder.findUnique({ where: { id: masterOrderId }, include: { subOrders: true } });
      if (!order) throw new NotFoundException('Order not found');
      if (!['CUSTOMER_DECISION_REQUIRED', 'RESOLUTION_REQUIRED'].includes(order.status)) throw new BadRequestException('Order is not waiting for partial resolution');

      const rejectedBrandIds = order.subOrders.filter((s) => s.status === 'REJECTED' || s.status === 'PENDING_TIMEOUT').map((s) => s.brandId);
      const activeSubOrders = order.subOrders.filter((s) => !['REJECTED', 'CANCELLED', 'PENDING_TIMEOUT'].includes(s.status));
      if (!activeSubOrders.length) throw new BadRequestException('No active sub-orders left');

      const originalTotal = order.totalCents;
      const newSubtotal = activeSubOrders.reduce((sum, s) => sum + s.subtotalCents, 0);
      const newDeliveryFee = newSubtotal >= order.freeDeliveryThresholdCents ? 0 : 200;
      const newDiscount = order.paymentMethod === 'CASH' ? Math.round(newSubtotal * 0.05) : 0;
      const newTotal = newSubtotal + newDeliveryFee - newDiscount;

      if (rejectedBrandIds.length) {
        await this.ledger.reverseOrderEntriesTx(tx, masterOrderId, { reverseDeliveryFee: false, onlyBrandIds: rejectedBrandIds, onlyTypes: ['ORDER_REVENUE'] });
      }

      await this.ledger.replaceCashEntriesAfterPartialTx(tx, order, newTotal, newDiscount);

      if (order.paymentMethod === 'CREDIT') {
        const refundAmount = originalTotal - newTotal;
        if (refundAmount > 0) {
          await tx.customer.update({
            where: { id: order.customerId },
            data: { creditBalanceCents: { increment: refundAmount } },
          });
          await tx.creditEntry.create({
            data: {
              customerId: order.customerId,
              masterOrderId: order.id,
              amountCents: refundAmount,
              type: 'REFUND',
              description: `Partial refund for order #${order.orderNumber}`,
            },
          });
        }
      }

      await tx.subOrder.updateMany({ where: { masterOrderId, status: { in: ['REJECTED', 'PENDING_TIMEOUT'] } }, data: { status: 'CANCELLED' } });
      await tx.masterOrder.update({
        where: { id: masterOrderId },
        data: { status: 'PARTIALLY_CANCELLED', subtotalCents: newSubtotal, deliveryFeeCents: newDeliveryFee, discountCents: newDiscount, totalCents: newTotal },
      });
      await tx.adminAuditLog.create({ data: { actorId, action: 'CONTINUE_PARTIAL', entityType: 'MasterOrder', entityId: masterOrderId, metadata: { rejectedBrandIds, newSubtotal, newDeliveryFee, newDiscount, newTotal } } });

      return { status: 'PARTIALLY_CANCELLED' as const, totalCents: newTotal, activeBrandIds: activeSubOrders.map((s) => s.brandId), cancelledBrandIds: rejectedBrandIds };
    });

    this.realtime.emitToAdmins('ORDER_RESOLUTION_UPDATED', { masterOrderId, status: result.status, totalCents: result.totalCents });
    for (const brandId of result.activeBrandIds) {
      this.realtime.emitToMerchant(brandId, 'ORDER_RESOLUTION_UPDATED', { masterOrderId, status: result.status, totalCents: result.totalCents });
    }

    for (const brandId of result.cancelledBrandIds ?? []) {
      this.realtime.emitToMerchant(brandId, 'ORDER_REMOVED_AFTER_PARTIAL_CONTINUATION', {
        masterOrderId,
        status: 'CANCELLED_FOR_THIS_BRAND',
      });
    }

    return result;
  }
}
