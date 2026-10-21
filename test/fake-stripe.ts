import Stripe from 'stripe';

type Method =
  | 'paymentIntents.create'
  | 'paymentIntents.retrieve'
  | 'paymentIntents.cancel'
  | 'refunds.create';

interface FakeIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_received: number;
  currency: string;
  status: Stripe.PaymentIntent.Status;
  client_secret: string;
  metadata: Record<string, string>;
}

interface FakeRefund {
  id: string;
  object: 'refund';
  amount: number;
  payment_intent: string;
  status: string;
  metadata: Record<string, string>;
}

/**
 * In-memory stand-in for the Stripe SDK at the network boundary.
 *
 * It mimics the behaviours this service relies on: idempotency keys return the
 * original object, cancel refuses succeeded/processing intents, and failures
 * are real Stripe error classes. Webhook signing uses the real SDK.
 */
export class FakeStripe {
  readonly calls: Partial<Record<Method, number>> = {};
  refundStatus = 'succeeded';
  readonly webhooks = new Stripe('sk_test_dummy').webhooks;

  private readonly intents = new Map<string, FakeIntent>();
  private readonly refundsById = new Map<string, FakeRefund>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly failures: Partial<Record<Method, number>> = {};
  private seq = 0;

  readonly paymentIntents = {
    create: async (
      params: Stripe.PaymentIntentCreateParams,
      opts?: Stripe.RequestOptions,
    ) => {
      this.enter('paymentIntents.create');
      const existing = this.fromKey(opts, this.intents);
      if (existing) return existing;
      const id = `pi_fake_${++this.seq}`;
      const intent: FakeIntent = {
        id,
        object: 'payment_intent',
        amount: params.amount,
        amount_received: 0,
        currency: params.currency,
        status: 'requires_payment_method',
        client_secret: `${id}_secret`,
        metadata: (params.metadata ?? {}) as Record<string, string>,
      };
      this.intents.set(id, intent);
      if (opts?.idempotencyKey)
        this.byIdempotencyKey.set(opts.idempotencyKey, id);
      return { ...intent };
    },

    retrieve: async (id: string) => {
      this.enter('paymentIntents.retrieve');
      return { ...this.intent(id) };
    },

    cancel: async (id: string) => {
      this.enter('paymentIntents.cancel');
      const intent = this.intent(id);
      if (intent.status === 'succeeded' || intent.status === 'processing') {
        throw new Stripe.errors.StripeInvalidRequestError({
          message: `PaymentIntent has status ${intent.status}`,
          code: 'payment_intent_unexpected_state',
        });
      }
      intent.status = 'canceled';
      return { ...intent };
    },
  };

  readonly refunds = {
    create: async (
      params: Stripe.RefundCreateParams,
      opts?: Stripe.RequestOptions,
    ) => {
      this.enter('refunds.create');
      const existing = this.fromKey(opts, this.refundsById);
      if (existing) return existing;
      const intent = this.intent(params.payment_intent as string);
      const refund: FakeRefund = {
        id: `re_fake_${++this.seq}`,
        object: 'refund',
        amount: params.amount ?? intent.amount_received,
        payment_intent: intent.id,
        status: this.refundStatus,
        metadata: (params.metadata ?? {}) as Record<string, string>,
      };
      this.refundsById.set(refund.id, refund);
      if (opts?.idempotencyKey) {
        this.byIdempotencyKey.set(opts.idempotencyKey, refund.id);
      }
      return { ...refund };
    },
  };

  /** Simulates the customer paying (or the bank declining) outside our system. */
  setIntentStatus(id: string, status: Stripe.PaymentIntent.Status): void {
    const intent = this.intent(id);
    intent.status = status;
    if (status === 'succeeded') intent.amount_received = intent.amount;
  }

  /** The next `times` calls to `method` fail like a network outage. */
  failNext(method: Method, times = 1): void {
    this.failures[method] = times;
  }

  private enter(method: Method): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    if ((this.failures[method] ?? 0) > 0) {
      this.failures[method]! -= 1;
      throw new Stripe.errors.StripeConnectionError({
        message: 'An error occurred with our connection to Stripe',
      });
    }
  }

  private intent(id: string): FakeIntent {
    const intent = this.intents.get(id);
    if (!intent) {
      throw new Stripe.errors.StripeInvalidRequestError({
        message: `No such payment_intent: '${id}'`,
        code: 'resource_missing',
      });
    }
    return intent;
  }

  private fromKey<T>(
    opts: Stripe.RequestOptions | undefined,
    store: Map<string, T>,
  ) {
    const id =
      opts?.idempotencyKey && this.byIdempotencyKey.get(opts.idempotencyKey);
    return id ? { ...store.get(id)! } : undefined;
  }
}
