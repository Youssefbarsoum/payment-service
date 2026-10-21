import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import Stripe from 'stripe';
import request from 'supertest';

const signer = new Stripe('sk_test_dummy').webhooks;

export function piEvent(
  type: 'payment_intent.succeeded' | 'payment_intent.payment_failed',
  pi: { id: string; amount: number; currency?: string; orderId: string },
  eventId = `evt_${randomUUID()}`,
): Stripe.Event {
  const succeeded = type === 'payment_intent.succeeded';
  return {
    id: eventId,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: pi.id,
        object: 'payment_intent',
        amount: pi.amount,
        amount_received: succeeded ? pi.amount : 0,
        currency: pi.currency ?? 'usd',
        status: succeeded ? 'succeeded' : 'requires_payment_method',
        metadata: { order_id: pi.orderId },
      },
    },
  } as unknown as Stripe.Event;
}

export function refundEvent(
  type: 'refund.created' | 'refund.updated' | 'refund.failed',
  refund: { id: string; status: string; refundId?: string },
  eventId = `evt_${randomUUID()}`,
): Stripe.Event {
  return {
    id: eventId,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: refund.id,
        object: 'refund',
        status: refund.status,
        metadata: refund.refundId ? { refund_id: refund.refundId } : {},
      },
    },
  } as unknown as Stripe.Event;
}

/** Posts an event exactly as Stripe would: signed over the raw JSON bytes. */
export function postWebhook(
  server: Server,
  event: Stripe.Event,
  opts: { secret?: string; body?: string; signature?: string | null } = {},
) {
  const payload = JSON.stringify(event);
  const signature =
    opts.signature !== undefined
      ? opts.signature
      : signer.generateTestHeaderString({
          payload,
          secret: opts.secret ?? 'whsec_test',
        });
  const req = request(server)
    .post('/webhooks/stripe')
    .set('content-type', 'application/json');
  if (signature !== null) req.set('stripe-signature', signature);
  return req.send(opts.body ?? payload);
}
