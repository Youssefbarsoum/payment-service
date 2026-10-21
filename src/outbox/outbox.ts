import type { Tx } from '../db/db.module.js';
import { outbox } from '../db/schema.js';
import { requestContext } from '../request-context.js';

export type OutboxEvent =
  | 'order.paid'
  | 'payment.failed'
  | 'refund.requested'
  | 'order.refunded'
  | 'order.expired';

/**
 * Records an event in the caller's transaction. Never call a queue or an
 * external API directly from business code: a crash between the commit and
 * that call would lose the side effect. The relay publishes these rows instead.
 */
export async function enqueueOutbox(
  tx: Tx,
  event: OutboxEvent,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const requestId = requestContext.getStore()?.requestId;
  await tx.insert(outbox).values({
    eventType: event,
    aggregateId,
    payload: requestId ? { ...payload, requestId } : payload,
  });
}
