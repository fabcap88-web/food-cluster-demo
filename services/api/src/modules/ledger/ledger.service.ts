import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async createEntriesForOrderTx(tx: any, masterOrderId: string) {
    const order = await tx.masterOrder.findUnique({
      where: { id: masterOrderId },
      include: { subOrders: { include: { brand: true } }, captainBrand: true, deliveryTask: true },
    });

    if (!order) throw new NotFoundException('Master order not found');

    const entries: Array<any> = [];

    for (const subOrder of order.subOrders) {
      entries.push({
        brandId: subOrder.brandId,
        masterOrderId: order.id,
        type: 'ORDER_REVENUE',
        amountCents: subOrder.subtotalCents,
        description: `Revenue for order #${order.orderNumber} - ${subOrder.brand.name}`,
      });
    }

    if (order.deliveryFeeCents > 0 && order.captainBrandId) {
      entries.push({ brandId: order.captainBrandId, masterOrderId: order.id, type: 'DELIVERY_FEE', amountCents: order.deliveryFeeCents, description: `Delivery fee for order #${order.orderNumber}` });
    }

    if (order.paymentMethod === 'CASH' && order.captainBrandId) {
      entries.push({ brandId: order.captainBrandId, masterOrderId: order.id, type: 'CASH_COLLECTED', amountCents: -order.totalCents, description: `Cash collected for order #${order.orderNumber}` });
    }

    if (order.discountCents > 0 && order.captainBrandId) {
      entries.push({ brandId: order.captainBrandId, masterOrderId: order.id, type: 'CASH_DISCOUNT', amountCents: -order.discountCents, description: `Cash discount for order #${order.orderNumber}` });
    }

    if (entries.length) await tx.ledgerEntry.createMany({ data: entries });
    return entries;
  }

  async reverseOrderEntriesTx(
    tx: any,
    masterOrderId: string,
    options: { reverseDeliveryFee: boolean; onlyBrandIds?: string[]; onlyTypes?: string[] },
  ) {
    const defaultTypes = options.reverseDeliveryFee
      ? ['ORDER_REVENUE', 'DELIVERY_FEE', 'CASH_COLLECTED', 'CASH_DISCOUNT']
      : ['ORDER_REVENUE', 'CASH_COLLECTED', 'CASH_DISCOUNT'];

    const types = options.onlyTypes?.length ? options.onlyTypes : defaultTypes;

    const originalEntries = await tx.ledgerEntry.findMany({
      where: {
        masterOrderId,
        reversalOfId: null,
        type: { in: types },
        ...(options.onlyBrandIds?.length ? { brandId: { in: options.onlyBrandIds } } : {}),
      },
    });

    if (!originalEntries.length) return [];

    const existingReversals = await tx.ledgerEntry.findMany({
      where: { reversalOfId: { in: originalEntries.map((e: any) => e.id) } },
      select: { reversalOfId: true },
    });

    const reversed = new Set(existingReversals.map((r: any) => r.reversalOfId));
    const toReverse = originalEntries.filter((e: any) => !reversed.has(e.id));

    const reversalEntries = toReverse.map((entry: any) => ({
      brandId: entry.brandId,
      masterOrderId,
      type: 'REVERSAL',
      amountCents: -entry.amountCents,
      description: `Reversal of ${entry.type}`,
      reversalOfId: entry.id,
    }));

    if (reversalEntries.length) await tx.ledgerEntry.createMany({ data: reversalEntries });
    return reversalEntries;
  }

  async replaceCashEntriesAfterPartialTx(tx: any, order: any, newTotal: number, newDiscount: number) {
    if (order.paymentMethod !== 'CASH' || !order.captainBrandId) return;

    await this.reverseOrderEntriesTx(tx, order.id, {
      reverseDeliveryFee: false,
      onlyBrandIds: [order.captainBrandId],
      onlyTypes: ['CASH_COLLECTED', 'CASH_DISCOUNT'],
    });

    const entries: Array<any> = [
      {
        brandId: order.captainBrandId,
        masterOrderId: order.id,
        type: 'CASH_COLLECTED',
        amountCents: -newTotal,
        description: 'Cash collected recalculated after partial cancellation',
      },
    ];

    if (newDiscount > 0) {
      entries.push({
        brandId: order.captainBrandId,
        masterOrderId: order.id,
        type: 'CASH_DISCOUNT',
        amountCents: -newDiscount,
        description: 'Cash discount recalculated after partial cancellation',
      });
    }

    await tx.ledgerEntry.createMany({ data: entries });
  }

  async getCurrentLedger() {
    const periodStart = this.getStartOfCurrentWeek();
    const periodEnd = new Date();

    const brands = await this.prisma.brand.findMany({ orderBy: { name: 'asc' } });
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { createdAt: { gte: periodStart, lte: periodEnd }, settlementId: null },
    });

    const balances = brands.map((brand) => {
      const brandEntries = entries.filter((e) => e.brandId === brand.id);
      const reversedIds = new Set(
        brandEntries.filter((e) => e.type === 'REVERSAL' && e.reversalOfId).map((e) => e.reversalOfId),
      );
      const balanceCents = brandEntries.reduce((sum, e) => sum + e.amountCents, 0);

      return {
        brandId: brand.id,
        brandName: brand.name,
        balanceCents,
        grossSalesCents: brandEntries
          .filter((e) => e.type === 'ORDER_REVENUE' && !reversedIds.has(e.id))
          .reduce((s, e) => s + e.amountCents, 0),
        reversalsCents: brandEntries.filter((e) => e.type === 'REVERSAL').reduce((s, e) => s + e.amountCents, 0),
        cashCollectedCents: Math.abs(brandEntries.filter((e) => e.type === 'CASH_COLLECTED' && !reversedIds.has(e.id)).reduce((s, e) => s + e.amountCents, 0)),
        deliveryFeeCents: brandEntries.filter((e) => e.type === 'DELIVERY_FEE' && !reversedIds.has(e.id)).reduce((s, e) => s + e.amountCents, 0),
        discountsCents: Math.abs(brandEntries.filter((e) => e.type === 'CASH_DISCOUNT' && !reversedIds.has(e.id)).reduce((s, e) => s + e.amountCents, 0)),
        adjustmentsCents: brandEntries.filter((e) => e.type === 'MANUAL_ADJUSTMENT').reduce((s, e) => s + e.amountCents, 0),
        settlementLabel: balanceCents >= 0 ? 'TO_RECEIVE' : 'TO_PAY',
      };
    });

    const globalBalanceCents = balances.reduce((sum, b) => sum + b.balanceCents, 0);

    return {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      globalBalanceCents,
      isBalanced: globalBalanceCents === 0,
      balances,
    };
  }

  private getStartOfCurrentWeek() {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    return monday;
  }
}
