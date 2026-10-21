import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { DB, type Db } from '../db/db.module.js';
import { orders } from '../db/schema.js';
import { STRIPE } from './stripe.module.js';

const notPayable = () =>
  new ConflictException({
    code: 'order_not_payable',
    message: 'Order is not awaiting payment',
  });

@Injectable()
export class PaymentIntentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STRIPE) private readonly stripe: Stripe,
  ) {}

  /**
   * Idempotent per order, without a client key:
   * - our side: the order row remembers its PaymentIntent;
   * - Stripe's side: idempotency key `pi-<orderId>`, so a crash between the
   *   Stripe call and our DB write gets the same PaymentIntent back on retry.
   */
  async getOrCreate(
    orderId: string,
  ): Promise<{ paymentIntentId: string; clientSecret: string }> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!order) {
      throw new NotFoundException({
        code: 'order_not_found',
        message: 'Order not found',
      });
    }
    if (order.status !== 'pending_payment' || order.expiresAt <= new Date()) {
      throw notPayable();
    }

    const intent = await this.callStripe(() =>
      order.stripePaymentIntentId
        ? this.stripe.paymentIntents.retrieve(order.stripePaymentIntentId)
        : this.stripe.paymentIntents.create(
            {
              amount: order.totalCents,
              currency: order.currency,
              automatic_payment_methods: { enabled: true },
              metadata: { order_id: order.id },
            },
            { idempotencyKey: `pi-${order.id}` },
          ),
    );

    // Compare-and-set: never attach a PaymentIntent to an order that expired
    // while we were talking to Stripe. Matching the same id keeps concurrent callers idempotent.
    const saved = await this.db
      .update(orders)
      .set({ stripePaymentIntentId: intent.id, updatedAt: sql`now()` })
      .where(
        and(
          eq(orders.id, order.id),
          or(
            isNull(orders.stripePaymentIntentId),
            eq(orders.stripePaymentIntentId, intent.id),
          ),
          eq(orders.status, 'pending_payment'),
          gt(orders.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: orders.id });
    if (saved.length === 0) throw notPayable();

    return { paymentIntentId: intent.id, clientSecret: intent.client_secret! };
  }

  private async callStripe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        throw new BadGatewayException({
          code: 'payment_provider_unavailable',
          message: 'The payment provider is unavailable, please retry',
        });
      }
      throw err;
    }
  }
}
