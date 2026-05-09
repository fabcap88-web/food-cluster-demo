import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TimeoutService } from '../timeouts/timeout.service';

export type MerchantStatusUpdate = 'PREPARING' | 'READY' | 'HANDED_OFF' | 'CANCELLED';

@Injectable()
export class SubOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly realtime: RealtimeService,
    private readonly timeoutService: TimeoutService,
  ) {}

  async getMerchantOrders(brandId: string) {
    const orders = await this.prisma.subOrder.findMany({
      where: { brandId, status: { in: ['PENDING', 'PENDING_TIMEOUT', 'ACCEPTED_WAITING_GROUP', 'ACCEPTED', 'PREPARING', 'READY'] } },
      include: { brand: true, items: true, masterOrder: { include: { captainBrand: true, subOrders: true } } },
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
        items: order.items.map((item) => ({ name: item.nameSnapshot, quantity: item.quantity, notes: item.notes ?? undefined })),
        createdAt: order.createdAt.toISOString(),
      })),
    };
  }


  async acceptSubOrder(subOrderId: string, merchantBrandId: string, prepEtaMinutes: number) {
    this.validateEta(prepEtaMinutes);
    await this.timeoutService.cancelMerchantTimeout(subOrderId);

    try {
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

        const allSubOrders = await tx.subOrder.findMany({ where: { masterOrderId: updated.masterOrderId } });
        const allAccepted = allSubOrders.every((s) =>
          s.id === updated.id ? true : ['ACCEPTED_WAITING_GROUP', 'ACCEPTED'].includes(s.status),
        );

        if (allAccepted) {
          await tx.subOrder.updateMany({
            where: { masterOrderId: updated.masterOrderId, status: 'ACCEPTED_WAITING_GROUP' },
            data: { status: 'ACCEPTED' },
          });
          await tx.masterOrder.update({ where: { id: updated.masterOrderId }, data: { status: 'ACCEPTED' } });
        } else {
          await tx.masterOrder.update({ where: { id: updated.masterOrderId }, data: { status: 'PARTIALLY_ACCEPTED' } });
        }

        return { updated, masterOrderStatus: allAccepted ? 'ACCEPTED' : 'PARTIALLY_ACCEPTED' };
      }, { isolationLevel: 'Serializable' });

      const payload = { masterOrderId: result.updated.masterOrderId, subOrderId: result.updated.id, brandId: result.updated.brandId, status: result.updated.status, prepEtaMinutes };
      this.realtime.emitToAdmins('SUB_ORDER_STATUS_UPDATED', payload);
      this.realtime.emitToMerchant(result.updated.brandId, 'SUB_ORDER_STATUS_UPDATED', payload);

      return { subOrderId: result.updated.id, status: result.updated.status, prepEtaMinutes: result.updated.prepEtaMinutes, masterOrderStatus: result.masterOrderStatus };
    } catch (error: any) {
      if (error?.code === 'P2034') {
        return this.getCurrentSubOrderState(subOrderId, merchantBrandId);
      }

      throw error;
    }
  }

  async rejectSubOrder(subOrderId: string, merchantBrandId: string, reason: string) {
    if (!reason || reason.trim().length < 3) throw new BadRequestException('Reject reason is required');
    await this.timeoutService.cancelMerchantTimeout(subOrderId);

    const result = await this.prisma.$transaction(async (tx) => {
      const subOrder = await tx.subOrder.findFirst({ where: { id: subOrderId, brandId: merchantBrandId }, include: { masterOrder: true } });
      if (!subOrder) throw new NotFoundException('Sub-order not found');
      if (!['PENDING', 'PENDING_TIMEOUT', 'ACCEPTED_WAITING_GROUP', 'ACCEPTED'].includes(subOrder.status)) {
        throw new BadRequestException('This sub-order can no longer be rejected');
      }

      const updated = await tx.subOrder.update({ where: { id: subOrderId }, data: { status: 'REJECTED', rejectedReason: reason } });
      const allSubOrders = await tx.subOrder.findMany({ where: { masterOrderId: updated.masterOrderId } });
      const allTerminal = allSubOrders.every((s) =>
        ['REJECTED', 'CANCELLED', 'PENDING_TIMEOUT'].includes(s.status),
      );

      if (allTerminal) {
        await tx.masterOrder.update({
          where: { id: updated.masterOrderId },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
      } else {
        await tx.masterOrder.update({ where: { id: updated.masterOrderId }, data: { status: 'CUSTOMER_DECISION_REQUIRED' } });
      }

      return { updated, customerId: subOrder.masterOrder.customerId, masterOrderStatus: allTerminal ? 'CANCELLED' : 'CUSTOMER_DECISION_REQUIRED' };
    });

    const payload = { masterOrderId: result.updated.masterOrderId, subOrderId: result.updated.id, brandId: result.updated.brandId, status: result.updated.status, reason };
    this.realtime.emitToAdmins('SUB_ORDER_REJECTED', payload);
    this.realtime.emitToCustomer(result.customerId, 'SUB_ORDER_REJECTED', payload);

    if (result.masterOrderStatus === 'CUSTOMER_DECISION_REQUIRED') {
      await this.timeoutService.scheduleCustomerDecisionTimeout(result.updated.masterOrderId);
    }

    return { subOrderId: result.updated.id, status: result.updated.status, masterOrderStatus: result.masterOrderStatus };
  }

  async updateStatus(subOrderId: string, merchantBrandId: string, status: MerchantStatusUpdate) {
    const result = await this.prisma.$transaction(async (tx) => {
      const subOrder = await tx.subOrder.findFirst({ where: { id: subOrderId, brandId: merchantBrandId }, include: { masterOrder: true } });
      if (!subOrder) throw new NotFoundException('Sub-order not found');

      const terminalMasterStates = ['CANCELLED', 'DELIVERED', 'DISPUTED_REVIEW'];
      if (terminalMasterStates.includes(subOrder.masterOrder.status)) {
        throw new BadRequestException(`Cannot update sub-order for master status ${subOrder.masterOrder.status}`);
      }

      this.validateStatusTransition(subOrder.status, status);

      const data: Record<string, unknown> = { status };
      if (status === 'READY') data.readyAt = new Date();
      if (status === 'HANDED_OFF') data.handedOffAt = new Date();

      return tx.subOrder.update({ where: { id: subOrderId }, data });
    });

    const masterOrderStatus = await this.ordersService.recalculateMasterStatus(result.masterOrderId);

    const payload = { masterOrderId: result.masterOrderId, subOrderId: result.id, brandId: result.brandId, status: result.status };
    this.realtime.emitToAdmins('SUB_ORDER_STATUS_UPDATED', payload);
    this.realtime.emitToMerchant(result.brandId, 'SUB_ORDER_STATUS_UPDATED', payload);

    return { subOrderId: result.id, status: result.status, masterOrderStatus };
  }


  private async getCurrentSubOrderState(subOrderId: string, merchantBrandId: string) {
    const subOrder = await this.prisma.subOrder.findFirst({
      where: { id: subOrderId, brandId: merchantBrandId },
      include: { masterOrder: true },
    });

    if (!subOrder) throw new NotFoundException('Sub-order not found');

    return {
      subOrderId: subOrder.id,
      masterOrderId: subOrder.masterOrderId,
      status: subOrder.status,
      masterOrderStatus: subOrder.masterOrder.status,
    };
  }

  private validateEta(minutes: number) {
    if (![5, 10, 15, 20, 25, 30].includes(minutes)) throw new BadRequestException('Invalid preparation ETA');
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
    if (!allowed[current]?.includes(next)) throw new BadRequestException(`Invalid transition from ${current} to ${next}`);
  }
}
