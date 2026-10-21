import { Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/db.module.js';
import { orders, orderStatus } from '../db/schema.js';

export type OrderStatus = (typeof orderStatus.enumValues)[number];

const logger = new Logger('OrderStatus');

/**
 * The only way an order changes status: a compare-and-set.
 *
 * The UPDATE succeeds only if the order is still in one of the `from` states, so
 * two racing writers (webhook vs expiry sweeper, duplicate events, out-of-order
 * events) can never both win. Returns false when the transition lost the race or
 * is stale, and callers treat that as a no-op.
 */
export async function casOrderStatus(
  tx: DbOrTx,
  orderId: string,
  from: OrderStatus[],
  to: OrderStatus,
): Promise<boolean> {
  const updated = await tx
    .update(orders)
    .set({ status: to, updatedAt: sql`now()` })
    .where(and(eq(orders.id, orderId), inArray(orders.status, from)))
    .returning({ id: orders.id });
  if (updated.length === 0) {
    logger.debug({ orderId, from, to }, 'status transition skipped');
  }
  return updated.length === 1;
}
