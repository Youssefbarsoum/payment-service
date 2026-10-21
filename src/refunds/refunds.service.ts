import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { DB, type Db, type Tx } from '../db/db.module.js';
import { orders, payments, refunds } from '../db/schema.js';
import { casOrderStatus } from '../orders/order-status.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { STRIPE } from '../payments/stripe.module.js';

type AutoRefundReason = 'late_payment' | 'amount_mismatch';

const notRefundable = () =>
  new ConflictException({
    code: 'order_not_refundable',
    message:
      'Only paid or fulfilled orders without an active refund can be refunded',
  });

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STRIPE) private readonly stripe: Stripe,
  ) {}

  /**
   * Records the refund and queues the Stripe call through the outbox. The API
   * answers 202 right away: a Stripe outage delays the refund but never loses it.
   */
  async requestAdminRefund(
    tx: Tx,
    orderId: string,
  ): Promise<{ refundId: string; status: 'requested' }> {
    // Row lock: concurrent refund requests for one order queue up here, and
    // every one after the first sees refund_pending.
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update');
    if (!order) {
      throw new NotFoundException({
        code: 'order_not_found',
        message: 'Order not found',
      });
    }
    if (order.status !== 'paid' && order.status !== 'fulfilled') {
      throw notRefundable();
    }
    const [payment] = await tx
      .select()
      .from(payments)
      .where(
        and(eq(payments.orderId, orderId), eq(payments.status, 'succeeded')),
      );

    await casOrderStatus(tx, orderId, ['paid', 'fulfilled'], 'refund_pending');
    const [refund] = await tx
      .insert(refunds)
      .values({
        orderId,
        stripePaymentIntentId: payment.stripePaymentIntentId,
        amountCents: payment.amountCents,
        reason: 'admin',
        previousOrderStatus: order.status,
      })
      .onConflictDoNothing()
      .returning({ id: refunds.id });
    // The partial unique index is the backstop if the row lock is ever bypassed.
    if (!refund) throw notRefundable();

    await enqueueOutbox(tx, 'refund.requested', orderId, {
      orderId,
      refundId: refund.id,
    });
    return { refundId: refund.id, status: 'requested' };
  }

  /** Refunds money we can't keep. The order status is left alone; the refund row is the record. */
  async requestAutoRefund(
    tx: Tx,
    orderId: string,
    paymentIntentId: string,
    amountCents: number,
    reason: AutoRefundReason,
  ): Promise<void> {
    const [refund] = await tx
      .insert(refunds)
      .values({
        orderId,
        stripePaymentIntentId: paymentIntentId,
        amountCents,
        reason,
      })
      .onConflictDoNothing()
      .returning({ id: refunds.id });
    if (!refund) return; // a refund for this order is already in flight
    this.logger.warn(
      { orderId, reason, amountCents },
      'automatic refund requested',
    );
    await enqueueOutbox(tx, 'refund.requested', orderId, {
      orderId,
      refundId: refund.id,
    });
  }

  /** Worker job. Safe to run any number of times. */
  async submitToStripe(refundId: string): Promise<void> {
    const [refund] = await this.db
      .select()
      .from(refunds)
      .where(eq(refunds.id, refundId));
    if (!refund || refund.status !== 'requested') return;

    // Same idempotency key on every retry: Stripe returns the original refund
    // instead of refunding twice.
    const stripeRefund = await this.stripe.refunds.create(
      {
        payment_intent: refund.stripePaymentIntentId,
        amount: refund.amountCents,
        metadata: { refund_id: refund.id, order_id: refund.orderId },
      },
      { idempotencyKey: `refund-${refund.id}` },
    );
    await this.db
      .update(refunds)
      .set({ stripeRefundId: stripeRefund.id, updatedAt: sql`now()` })
      .where(and(eq(refunds.id, refund.id), isNull(refunds.stripeRefundId)));

    // Test-mode refunds often succeed immediately with no later refund.updated,
    // so apply the result now. The webhook applies it too; the CAS lets only one win.
    await this.applyRefundOutcome(refund.id, stripeRefund.status ?? 'pending');
  }

  /**
   * Moves a refund to its final state. Called from the worker, the refund
   * webhooks and the exhausted-retries handler, in any order and any number of
   * times: only the first call that sees `requested` does anything.
   */
  async applyRefundOutcome(
    refundId: string,
    stripeStatus: string,
    tx?: Tx,
  ): Promise<void> {
    const outcome =
      stripeStatus === 'succeeded'
        ? 'succeeded'
        : stripeStatus === 'failed' || stripeStatus === 'canceled'
          ? 'failed'
          : undefined;
    if (!outcome) return; // pending / requires_action: wait for the webhook

    const apply = async (tx: Tx) => {
      const [refund] = await tx
        .update(refunds)
        .set({ status: outcome, updatedAt: sql`now()` })
        .where(and(eq(refunds.id, refundId), eq(refunds.status, 'requested')))
        .returning();
      if (!refund) return;

      if (outcome === 'failed') {
        // ponytail: a human resolves failed refunds (logs + DLQ); add alerting when there's an on-call.
        this.logger.error(
          { refundId, orderId: refund.orderId, reason: refund.reason },
          'refund failed',
        );
      }
      if (refund.reason !== 'admin') return;

      if (outcome === 'succeeded') {
        if (
          await casOrderStatus(
            tx,
            refund.orderId,
            ['refund_pending'],
            'refunded',
          )
        ) {
          await enqueueOutbox(tx, 'order.refunded', refund.orderId, {
            orderId: refund.orderId,
          });
        }
      } else {
        const restored = await casOrderStatus(
          tx,
          refund.orderId,
          ['refund_pending'],
          refund.previousOrderStatus!,
        );
        // Its fulfillment job may have run (and skipped) while the refund was
        // pending, so a restored paid order needs fulfilling again.
        if (restored && refund.previousOrderStatus === 'paid') {
          await enqueueOutbox(
            tx,
            'order.fulfillment_requested',
            refund.orderId,
            { orderId: refund.orderId },
          );
        }
      }
    };
    await (tx ? apply(tx) : this.db.transaction(apply));
  }

  async exists(tx: Tx, refundId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(eq(refunds.id, refundId));
    return !!row;
  }
}
