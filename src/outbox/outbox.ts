import type { Tx } from '../db/db.module.js';
import { outbox } from '../db/schema.js';
import type { JobName } from '../queue/jobs.js';
import { requestContext } from '../request-context.js';

export type OutboxEvent =
  | 'order.paid'
  | 'payment.failed'
  | 'refund.requested'
  | 'order.refunded'
  | 'order.expired'
  | 'order.fulfillment_requested';

/** Which background jobs each event triggers. order.expired is recorded for audit only. */
export const EVENT_JOBS: Record<OutboxEvent, JobName[]> = {
  'order.paid': ['fulfill-order', 'email-order-confirmation'],
  'payment.failed': ['email-payment-failed'],
  'refund.requested': ['stripe-refund'],
  'order.refunded': ['email-refund-confirmation'],
  'order.expired': [],
  // Re-queued fulfillment: after a failed refund, or a paid order whose job was lost.
  'order.fulfillment_requested': ['fulfill-order'],
};

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
