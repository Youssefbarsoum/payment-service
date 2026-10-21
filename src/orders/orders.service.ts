import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { DB, type Db, type Tx } from '../db/db.module.js';
import { orderItems, orders, products } from '../db/schema.js';
import type { CreateOrderDto } from './orders.dto.js';
import type { OrderStatus } from './order-status.js';

export const ORDER_TTL_MS = 15 * 60_000;

export interface OrderView {
  id: string;
  status: OrderStatus;
  customerEmail: string;
  totalCents: number;
  currency: string;
  expiresAt: string;
  items: { productId: number; quantity: number; unitPriceCents: number }[];
}

@Injectable()
export class OrdersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Reserves stock and creates the order inside the caller's transaction, so
   * the idempotency layer can commit the order and its stored response together.
   */
  async createInTx(tx: Tx, dto: CreateOrderDto): Promise<OrderView> {
    // Lock product rows in a consistent order: two orders for [A, B] and
    // [B, A] would otherwise each hold one lock and wait on the other (deadlock).
    const items = [...dto.items].sort((a, b) => a.productId - b.productId);

    const lines: OrderView['items'] = [];
    for (const { productId, quantity } of items) {
      // Atomic check-and-decrement: no read-then-write window for a racing buyer.
      const [reserved] = await tx
        .update(products)
        .set({ stock: sql`${products.stock} - ${quantity}` })
        .where(and(eq(products.id, productId), gte(products.stock, quantity)))
        .returning({ priceCents: products.priceCents });

      if (!reserved) {
        const [exists] = await tx
          .select({ id: products.id })
          .from(products)
          .where(eq(products.id, productId));
        // Throwing rolls back every reservation made so far in this transaction.
        throw exists
          ? new ConflictException({
              code: 'out_of_stock',
              message: `Not enough stock for product ${productId}`,
            })
          : new NotFoundException({
              code: 'product_not_found',
              message: `Product ${productId} does not exist`,
            });
      }
      lines.push({ productId, quantity, unitPriceCents: reserved.priceCents });
    }

    const [order] = await tx
      .insert(orders)
      .values({
        customerEmail: dto.email,
        totalCents: lines.reduce(
          (s, l) => s + l.quantity * l.unitPriceCents,
          0,
        ),
        expiresAt: new Date(Date.now() + ORDER_TTL_MS),
      })
      .returning();
    await tx
      .insert(orderItems)
      .values(lines.map((l) => ({ orderId: order.id, ...l })));

    return toView(order, lines);
  }

  async get(id: string): Promise<OrderView> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, id));
    if (!order) {
      throw new NotFoundException({
        code: 'order_not_found',
        message: 'Order not found',
      });
    }
    const lines = await this.db
      .select({
        productId: orderItems.productId,
        quantity: orderItems.quantity,
        unitPriceCents: orderItems.unitPriceCents,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, id))
      .orderBy(asc(orderItems.productId));
    return toView(order, lines);
  }
}

function toView(
  order: typeof orders.$inferSelect,
  items: OrderView['items'],
): OrderView {
  return {
    id: order.id,
    status: order.status,
    customerEmail: order.customerEmail,
    totalCents: order.totalCents,
    currency: order.currency,
    expiresAt: order.expiresAt.toISOString(),
    items,
  };
}
