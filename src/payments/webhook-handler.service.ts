import { Inject, Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { DB, type Db, type Tx } from '../db/db.module.js';
import { orders, payments, webhookEvents } from '../db/schema.js';
import { casOrderStatus } from '../orders/order-status.js';
import { enqueueOutbox } from '../outbox/outbox.js';

@Injectable()
export class WebhookHandlerService {
  private readonly logger = new Logger(WebhookHandlerService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Dedupe and handling share one transaction. If handling fails, the dedupe
   * row rolls back with it and Stripe's retry processes the event again.
   * Only database work happens here; side effects go through the outbox.
   */
  async handle(event: Stripe.Event): Promise<'processed' | 'duplicate'> {
    return this.db.transaction(async (tx) => {
      // A concurrent duplicate blocks here until the first delivery commits.
      const inserted = await tx
        .insert(webhookEvents)
        .values({ stripeEventId: event.id, type: event.type, payload: event })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.stripeEventId });
      if (inserted.length === 0) return 'duplicate';

      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.onPaymentSucceeded(tx, event);
          break;
        case 'payment_intent.payment_failed':
          await this.onPaymentFailed(tx, event);
          break;
      }

      await tx
        .update(webhookEvents)
        .set({ processedAt: sql`now()` })
        .where(eq(webhookEvents.stripeEventId, event.id));
      return 'processed';
    });
  }

  private async onPaymentSucceeded(
    tx: Tx,
    event: Stripe.PaymentIntentSucceededEvent,
  ): Promise<void> {
    const pi = event.data.object;
    const order = await this.findOrder(tx, pi);
    if (!order) return;

    await this.recordPayment(tx, event.id, order.id, pi, 'succeeded');

    if (
      pi.amount_received !== order.totalCents ||
      pi.currency !== order.currency
    ) {
      this.logger.error(
        {
          orderId: order.id,
          expected: order.totalCents,
          received: pi.amount_received,
        },
        'payment amount does not match order total',
      );
      return;
    }

    // Compare-and-set: a duplicate, stale or late event finds the order already
    // past pending_payment and does nothing.
    if (await casOrderStatus(tx, order.id, ['pending_payment'], 'paid')) {
      await enqueueOutbox(tx, 'order.paid', order.id, { orderId: order.id });
    }
  }

  private async onPaymentFailed(
    tx: Tx,
    event: Stripe.PaymentIntentPaymentFailedEvent,
  ): Promise<void> {
    const pi = event.data.object;
    const order = await this.findOrder(tx, pi);
    if (!order) return;

    await this.recordPayment(tx, event.id, order.id, pi, 'failed');
    // The customer can retry with another card, so the order stays pending.
    if (order.status === 'pending_payment') {
      await enqueueOutbox(tx, 'payment.failed', order.id, {
        orderId: order.id,
      });
    }
  }

  private async findOrder(tx: Tx, pi: Stripe.PaymentIntent) {
    const orderId = pi.metadata?.order_id;
    // Acknowledge rather than throw: an event we can never match must not be retried forever.
    if (!orderId || !isUUID(orderId)) {
      this.logger.warn({ paymentIntentId: pi.id }, 'event without order_id');
      return undefined;
    }
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!order) {
      this.logger.warn({ orderId, paymentIntentId: pi.id }, 'unknown order');
    }
    return order;
  }

  private async recordPayment(
    tx: Tx,
    eventId: string,
    orderId: string,
    pi: Stripe.PaymentIntent,
    status: 'succeeded' | 'failed',
  ): Promise<void> {
    await tx.insert(payments).values({
      orderId,
      stripePaymentIntentId: pi.id,
      stripeEventId: eventId,
      amountCents: status === 'succeeded' ? pi.amount_received : pi.amount,
      currency: pi.currency,
      status,
    });
  }
}
