import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { DB, type Db } from '../db/db.module.js';
import {
  idempotencyKeys,
  orders,
  outbox,
  refunds,
  webhookEvents,
} from '../db/schema.js';
import { casOrderStatus } from '../orders/order-status.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { STRIPE } from '../payments/stripe.module.js';
import { backgroundLoopsEnabled, runEvery } from '../run-every.js';

/** How long past expires_at we wait for a payment Stripe reports as succeeded or processing. */
export const HARD_EXPIRY_GRACE_MS = 60 * 60_000;
const RETENTION_MS = 7 * 24 * 3600_000;
const SWEEP_INTERVAL_MS = 30_000;
const PRUNE_INTERVAL_MS = 3600_000;
const BATCH_SIZE = 100;
/** Fulfillment takes seconds and refunds settle quickly; anything older than this is stuck. */
const STALE_WORK_MS = 10 * 60_000;

@Injectable()
export class MaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MaintenanceService.name);
  private readonly stops: (() => void)[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STRIPE) private readonly stripe: Stripe,
  ) {}

  onApplicationBootstrap() {
    if (!backgroundLoopsEnabled()) return;
    this.stops.push(
      runEvery(SWEEP_INTERVAL_MS, () => this.sweepExpiredOrders(), this.logger),
      runEvery(SWEEP_INTERVAL_MS, () => this.retryStaleWork(), this.logger),
      runEvery(PRUNE_INTERVAL_MS, () => this.pruneOldRecords(), this.logger),
    );
  }

  onModuleDestroy() {
    this.stops.forEach((stop) => stop());
  }

  /**
   * Re-queues work that should have finished by now, from Postgres. This
   * covers jobs that exhausted their retries during an outage and jobs lost
   * with Redis data:
   * - refunds still `requested` (safe: Stripe idempotency key refund-<id>);
   * - orders still `paid` (safe: fulfillment is a compare-and-set).
   * Bumping updated_at in the same UPDATE makes concurrent sweepers skip rows
   * another one just claimed, and spaces out the next retry.
   */
  async retryStaleWork(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - STALE_WORK_MS);
    await this.db.transaction(async (tx) => {
      const staleRefunds = await tx
        .update(refunds)
        .set({ updatedAt: sql`now()` })
        .where(
          and(eq(refunds.status, 'requested'), lt(refunds.updatedAt, cutoff)),
        )
        .returning({ id: refunds.id, orderId: refunds.orderId });
      for (const r of staleRefunds) {
        await enqueueOutbox(tx, 'refund.requested', r.orderId, {
          orderId: r.orderId,
          refundId: r.id,
        });
      }

      const staleOrders = await tx
        .update(orders)
        .set({ updatedAt: sql`now()` })
        .where(and(eq(orders.status, 'paid'), lt(orders.updatedAt, cutoff)))
        .returning({ id: orders.id });
      for (const o of staleOrders) {
        await enqueueOutbox(tx, 'order.fulfillment_requested', o.id, {
          orderId: o.id,
        });
      }

      if (staleRefunds.length + staleOrders.length > 0) {
        this.logger.warn(
          { refunds: staleRefunds.length, orders: staleOrders.length },
          're-queued stale work',
        );
      }
    });
  }

  /**
   * Expires unpaid orders and returns their stock. Driven by Postgres, not by
   * delayed jobs, so it survives Redis losing data.
   *
   * Safe to run on many workers at once: cancel is idempotent and the
   * compare-and-set lets exactly one sweeper expire each order.
   */
  async sweepExpiredOrders(
    now = new Date(),
  ): Promise<{ expired: number; skipped: number }> {
    const due = await this.db
      .select({
        id: orders.id,
        expiresAt: orders.expiresAt,
        paymentIntentId: orders.stripePaymentIntentId,
      })
      .from(orders)
      .where(
        and(eq(orders.status, 'pending_payment'), lt(orders.expiresAt, now)),
      )
      .orderBy(asc(orders.expiresAt))
      .limit(BATCH_SIZE);

    let expired = 0;
    let skipped = 0;
    for (const order of due) {
      if (
        order.paymentIntentId &&
        !(await this.stopPayment(order.paymentIntentId, order.expiresAt, now))
      ) {
        skipped++;
        continue;
      }
      if (await this.expire(order.id)) expired++;
    }
    if (expired > 0 || skipped > 0) {
      this.logger.log({ expired, skipped }, 'expiry sweep');
    }
    return { expired, skipped };
  }

  /**
   * Makes sure the customer can no longer pay. Returns false to keep the order
   * pending for now: the payment may still be about to succeed, or Stripe is
   * unreachable. The next sweep checks again.
   */
  private async stopPayment(
    paymentIntentId: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean> {
    try {
      const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.status === 'succeeded' || pi.status === 'processing') {
        // The webhook will mark it paid. Past the hard deadline we expire anyway,
        // and a payment that still lands is refunded automatically.
        return now.getTime() >= expiresAt.getTime() + HARD_EXPIRY_GRACE_MS;
      }
      if (pi.status !== 'canceled') {
        await this.stripe.paymentIntents.cancel(paymentIntentId);
      }
      return true;
    } catch (err) {
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === 'payment_intent_unexpected_state'
      ) {
        return false; // it moved to processing/succeeded between retrieve and cancel
      }
      this.logger.warn(
        { paymentIntentId, err: (err as Error).message },
        'could not stop payment; will retry next sweep',
      );
      return false;
    }
  }

  private expire(orderId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      if (
        !(await casOrderStatus(tx, orderId, ['pending_payment'], 'expired'))
      ) {
        return false; // paid or expired by someone else meanwhile
      }
      await tx.execute(sql`
        update products
        set stock = products.stock + order_items.quantity
        from order_items
        where order_items.order_id = ${orderId}
          and products.id = order_items.product_id`);
      await enqueueOutbox(tx, 'order.expired', orderId, { orderId });
      return true;
    });
  }

  /** Keeps the dedupe tables small. Unpublished outbox rows are never deleted. */
  async pruneOldRecords(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    await this.db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.createdAt, cutoff));
    await this.db
      .delete(webhookEvents)
      .where(lt(webhookEvents.receivedAt, cutoff));
    await this.db
      .delete(outbox)
      .where(
        and(isNotNull(outbox.publishedAt), lt(outbox.publishedAt, cutoff)),
      );
  }
}
