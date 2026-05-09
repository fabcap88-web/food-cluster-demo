import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { TimeoutService } from '../timeouts/timeout.service';
import { RealtimeService } from '../realtime/realtime.service';
import * as crypto from 'crypto';

interface CreateOrderInput {
  idempotencyKey: string;
  customer: { id?: string; name?: string; phone: string };
  address: { street: string; city: string; notes?: string; lat?: number; lng?: number };
  items: Array<{ productId: string; quantity: number; notes?: string }>;
  paymentMethod: 'CASH' | 'CREDIT' | 'CARD_LATER';
  customerNotes?: string;
}

@Injectable()
export class OrdersService {
  private readonly freeDeliveryThresholdCents = 2500;
  private readonly standardDeliveryFeeCents = 200;
  private readonly cashDiscountRate = 0.05;
  private readonly terminalStatuses = ['CANCELLED', 'DELIVERED', 'DISPUTED_REVIEW', 'READY_FOR_PICKUP', 'PICKED_UP'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly timeoutService: TimeoutService,
    private readonly realtime: RealtimeService,
  ) {}

  async quote(input: Pick<CreateOrderInput, 'items' | 'paymentMethod'>) {
    this.validateItems(input.items);
    const products = await this.getValidatedProducts(input.items);
    const subtotalCents = this.calculateSubtotal(input.items, products);
    const deliveryFeeCents = subtotalCents >= this.freeDeliveryThresholdCents ? 0 : this.standardDeliveryFeeCents;
    const discountCents = input.paymentMethod === 'CASH' ? Math.round(subtotalCents * this.cashDiscountRate) : 0;
    const totalCents = subtotalCents + deliveryFeeCents - discountCents;
    if (totalCents <= 0) throw new BadRequestException('Invalid order total');
    return {
      subtotalCents,
      deliveryFeeCents,
      discountCents,
      totalCents,
      freeDeliveryThresholdCents: this.freeDeliveryThresholdCents,
      missingForFreeDeliveryCents: Math.max(0, this.freeDeliveryThresholdCents - subtotalCents),
    };
  }

  async createOrder(input: CreateOrderInput) {
    this.validateItems(input.items);
    if (!input.idempotencyKey) throw new BadRequestException('idempotencyKey is required');

    const requestHash = this.hashRequest(input);

    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: input.idempotencyKey,
          customerPhone: input.customer.phone,
          requestHash,
          status: 'PROCESSING',
        },
      });
    } catch {
      const existing = await this.prisma.idempotencyKey.findUnique({ where: { key: input.idempotencyKey } });
      if (!existing) throw new ConflictException('Idempotency conflict');
      if (existing.customerPhone !== input.customer.phone) throw new ConflictException('Idempotency key already used');
      if (existing.requestHash && existing.requestHash !== requestHash) throw new ConflictException('Same idempotency key used with different request body');

      if (existing.status === 'FAILED') {
        throw new ConflictException('Previous attempt failed. Generate a new idempotency key and retry.');
      }

      if (existing.status === 'PROCESSING') {
        const staleAfterMs = 5 * 60 * 1000;
        const ageMs = Date.now() - existing.createdAt.getTime();

        if (ageMs > staleAfterMs) {
          await this.prisma.idempotencyKey.update({
            where: { key: input.idempotencyKey },
            data: { status: 'FAILED' },
          });

          throw new ConflictException('Previous order attempt expired. Generate a new idempotency key and retry.');
        }
      }

      if (existing.status === 'COMPLETED' && existing.masterOrderId) {
        const order = await this.prisma.masterOrder.findUnique({ where: { id: existing.masterOrderId } });
        if (!order) throw new ConflictException('Idempotent order missing');
        return {
          masterOrderId: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          totalCents: order.totalCents,
          trackingUrl: `/tracking/${order.id}`,
          idempotentReplay: true,
        };
      }

      throw new ConflictException('Order is already being processed. Retry shortly.');
    }

    try {
      const products = await this.getValidatedProducts(input.items);
      const grouped = this.groupItemsByBrand(input.items, products);
      const subtotalCents = this.calculateSubtotal(input.items, products);
      const deliveryFeeCents = subtotalCents >= this.freeDeliveryThresholdCents ? 0 : this.standardDeliveryFeeCents;
      const discountCents = input.paymentMethod === 'CASH' ? Math.round(subtotalCents * this.cashDiscountRate) : 0;
      const totalCents = subtotalCents + deliveryFeeCents - discountCents;
      if (totalCents <= 0) throw new BadRequestException('Invalid order total');

      const captain = this.selectCaptainBrand(grouped);

      const result = await this.prisma.$transaction(async (tx) => {
        let customer;

        if (input.customer.id) {
          customer = await tx.customer.findUnique({
            where: { id: input.customer.id },
          });

          if (!customer || customer.phone !== input.customer.phone) {
            throw new BadRequestException('Invalid customer identity');
          }

          if (input.customer.name && input.customer.name !== customer.name) {
            customer = await tx.customer.update({
              where: { id: customer.id },
              data: { name: input.customer.name },
            });
          }
        } else {
          // Dev fallback only. In production, createOrder is guarded and customer.id comes from JWT.
          customer = await tx.customer.upsert({
            where: { phone: input.customer.phone },
            update: { name: input.customer.name },
            create: { phone: input.customer.phone, name: input.customer.name },
          });
        }

        const address = await tx.address.create({
          data: {
            customerId: customer.id,
            street: input.address.street,
            city: input.address.city,
            notes: input.address.notes,
            lat: input.address.lat,
            lng: input.address.lng,
          },
        });

        if (input.paymentMethod === 'CREDIT') {
          const updated = await tx.customer.updateMany({
            where: { id: customer.id, creditBalanceCents: { gte: totalCents } },
            data: { creditBalanceCents: { decrement: totalCents } },
          });
          if (updated.count !== 1) throw new BadRequestException('Insufficient credit balance');
        }

        const court = await tx.virtualCourt.findFirst({ where: { isActive: true } });

        const masterOrder = await tx.masterOrder.create({
          data: {
            courtId: court?.id,
            customerId: customer.id,
            addressId: address.id,
            captainBrandId: captain.brandId,
            idempotencyKey: input.idempotencyKey,
            paymentMethod: input.paymentMethod,
            subtotalCents,
            deliveryFeeCents,
            discountCents,
            totalCents,
            freeDeliveryThresholdCents: this.freeDeliveryThresholdCents,
            customerNotes: input.customerNotes,
            status: 'WAITING_MERCHANT_ACCEPTANCE',
          },
        });

        const subOrders = [];
        for (const group of grouped) {
          const subOrder = await tx.subOrder.create({
            data: {
              masterOrderId: masterOrder.id,
              brandId: group.brandId,
              subtotalCents: group.subtotalCents,
              prepEtaMinutes: group.estimatedPrepMinutes,
              status: 'PENDING',
            },
          });

          for (const item of group.items) {
            await tx.orderItem.create({
              data: {
                subOrderId: subOrder.id,
                productId: item.product.id,
                nameSnapshot: item.product.name,
                brandSnapshot: group.brandName,
                unitPriceCents: item.product.priceCents,
                quantity: item.quantity,
                notes: item.notes,
              },
            });
          }

          subOrders.push({ ...subOrder, brandName: group.brandName });
        }

        await tx.deliveryTask.create({
          data: {
            masterOrderId: masterOrder.id,
            status: 'UNASSIGNED',
            pickupSequence: grouped
              .sort((a, b) => b.estimatedPrepMinutes - a.estimatedPrepMinutes)
              .map((g) => ({ brandId: g.brandId, brandName: g.brandName, estimatedPrepMinutes: g.estimatedPrepMinutes })),
          },
        });

        await this.ledger.createEntriesForOrderTx(tx, masterOrder.id);

        if (input.paymentMethod === 'CREDIT') {
          await tx.creditEntry.create({
            data: {
              customerId: customer.id,
              masterOrderId: masterOrder.id,
              amountCents: -totalCents,
              type: 'USED',
              description: `Payment for order #${masterOrder.orderNumber}`,
            },
          });
        }

        await tx.idempotencyKey.update({
          where: { key: input.idempotencyKey },
          data: { status: 'COMPLETED', masterOrderId: masterOrder.id },
        });

        return { masterOrder, subOrders, customer };
      });

      for (const subOrder of result.subOrders) {
        await this.timeoutService.scheduleMerchantAcceptanceTimeout(subOrder.id);
      }

      const response = {
        masterOrderId: result.masterOrder.id,
        orderNumber: result.masterOrder.orderNumber,
        status: result.masterOrder.status,
        totalCents: result.masterOrder.totalCents,
        captainBrand: { id: captain.brandId, name: captain.brandName },
        subOrders: result.subOrders.map((s) => ({
          id: s.id,
          brandId: s.brandId,
          brandName: s.brandName,
          status: s.status,
          subtotalCents: s.subtotalCents,
          estimatedPrepMinutes: s.prepEtaMinutes ?? captain.estimatedPrepMinutes,
        })),
        trackingUrl: `/tracking/${result.masterOrder.id}`,
      };

      this.realtime.emitToAdmins('MASTER_ORDER_CREATED', response);
      for (const subOrder of response.subOrders) {
        this.realtime.emitToMerchant(subOrder.brandId, 'MASTER_ORDER_CREATED', response);
      }

      return response;
    } catch (error) {
      await this.prisma.idempotencyKey.update({
        where: { key: input.idempotencyKey },
        data: { status: 'FAILED' },
      }).catch((err) => {
        console.error(`[CRITICAL] Failed to mark idempotency key ${input.idempotencyKey} as FAILED`, err);
      });
      throw error;
    }
  }

  async getTracking(masterOrderId: string, customerId: string) {
    const order = await this.prisma.masterOrder.findFirst({
      where: { id: masterOrderId, customerId },
      include: { subOrders: { include: { brand: true } }, deliveryTask: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const rejected = order.subOrders.filter((s) => s.status === 'REJECTED' || s.status === 'PENDING_TIMEOUT');

    return {
      masterOrderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      requiresCustomerDecision: order.status === 'CUSTOMER_DECISION_REQUIRED',
      requiresAdminResolution: order.status === 'RESOLUTION_REQUIRED',
      decisionPayload: rejected.length
        ? {
            rejectedBrands: rejected.map((s) => ({ brandId: s.brandId, brandName: s.brand.name, reason: s.rejectedReason })),
            allowedActions: ['CONTINUE_PARTIAL', 'CANCEL_ALL'],
          }
        : null,
      subOrders: order.subOrders.map((s) => ({
        brandId: s.brandId,
        brandName: s.brand.name,
        status: s.status,
        prepEtaMinutes: s.prepEtaMinutes,
      })),
      deliveryStatus: order.deliveryTask?.status ?? 'UNASSIGNED',
    };
  }

  async recalculateMasterStatus(masterOrderId: string) {
    const masterOrder = await this.prisma.masterOrder.findUnique({ where: { id: masterOrderId }, include: { subOrders: true } });
    if (!masterOrder) throw new NotFoundException('Master order not found');

    if (this.terminalStatuses.includes(masterOrder.status)) {
      return masterOrder.status;
    }

    const statuses = masterOrder.subOrders.map((s) => s.status);
    let nextStatus = masterOrder.status;

    if (statuses.every((s) => s === 'REJECTED' || s === 'CANCELLED' || s === 'PENDING_TIMEOUT')) nextStatus = 'CANCELLED';
    else if (statuses.some((s) => s === 'REJECTED' || s === 'CANCELLED' || s === 'PENDING_TIMEOUT')) nextStatus = 'CUSTOMER_DECISION_REQUIRED';
    else if (statuses.every((s) => s === 'READY' || s === 'HANDED_OFF')) nextStatus = 'READY_FOR_PICKUP';
    else if (statuses.some((s) => s === 'PREPARING')) nextStatus = 'PREPARING';
    else if (statuses.every((s) => s === 'ACCEPTED')) nextStatus = 'ACCEPTED';
    else if (statuses.some((s) => s === 'ACCEPTED_WAITING_GROUP')) nextStatus = 'PARTIALLY_ACCEPTED';

    if (nextStatus !== masterOrder.status) {
      await this.prisma.masterOrder.updateMany({
        where: { id: masterOrderId, status: masterOrder.status },
        data: { status: nextStatus },
      });
      this.realtime.emitToAdmins('MASTER_ORDER_STATUS_UPDATED', { masterOrderId, status: nextStatus });
      this.realtime.emitToCustomer(masterOrder.customerId, 'MASTER_ORDER_STATUS_UPDATED', { masterOrderId, status: nextStatus });
    }

    return nextStatus;
  }

  private validateItems(items: CreateOrderInput['items']) {
    if (!items?.length) throw new BadRequestException('Order must contain at least one item');
    for (const item of items) {
      if (!item.productId) throw new BadRequestException('Missing productId');
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
        throw new BadRequestException(`Invalid quantity for product ${item.productId}`);
      }
    }
  }

  private hashRequest(input: CreateOrderInput) {
    return crypto.createHash('sha256').update(JSON.stringify({
      phone: input.customer.phone,
      address: input.address,
      items: input.items,
      paymentMethod: input.paymentMethod,
      customerNotes: input.customerNotes,
    })).digest('hex');
  }

  private async getValidatedProducts(items: CreateOrderInput['items']) {
    const ids = items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: ids }, status: 'ACTIVE', brand: { status: 'ACTIVE' } },
      include: { brand: true },
    });
    if (products.length !== new Set(ids).size) throw new BadRequestException('Some products are unavailable');
    return products;
  }

  private calculateSubtotal(items: CreateOrderInput['items'], products: any[]) {
    return items.reduce((total, item) => {
      const product = products.find((p) => p.id === item.productId);
      if (!product) throw new BadRequestException('Invalid product');
      return total + product.priceCents * item.quantity;
    }, 0);
  }

  private groupItemsByBrand(items: CreateOrderInput['items'], products: any[]) {
    const map = new Map<string, any>();
    for (const item of items) {
      const product = products.find((p) => p.id === item.productId);
      if (!product) throw new BadRequestException('Invalid product');

      const current = map.get(product.brandId) ?? {
        brandId: product.brandId,
        brandName: product.brand.name,
        subtotalCents: 0,
        estimatedPrepMinutes: product.brand.defaultPrepMinutes,
        items: [],
      };

      current.subtotalCents += product.priceCents * item.quantity;
      current.estimatedPrepMinutes = Math.max(current.estimatedPrepMinutes, product.prepMinutes ?? product.brand.defaultPrepMinutes);
      current.items.push({ quantity: item.quantity, notes: item.notes, product });
      map.set(product.brandId, current);
    }
    return Array.from(map.values());
  }

  private selectCaptainBrand(groups: any[]) {
    if (!groups.length) throw new BadRequestException('No brand involved');
    return groups.reduce((winner, current) => {
      if (current.estimatedPrepMinutes > winner.estimatedPrepMinutes) return current;
      if (current.estimatedPrepMinutes === winner.estimatedPrepMinutes && current.subtotalCents > winner.subtotalCents) return current;
      return winner;
    }, groups[0]);
  }
}
