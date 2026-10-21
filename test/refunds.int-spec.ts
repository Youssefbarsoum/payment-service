import { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Server } from 'node:http';
import request from 'supertest';
import type { Db } from '../src/db/db.module.js';
import { orders, outbox, refunds } from '../src/db/schema.js';
import { JobsProcessor } from '../src/jobs/jobs.processor.js';
import type { OrderStatus } from '../src/orders/order-status.js';
import type { OrderView } from '../src/orders/orders.service.js';
import type { JobData } from '../src/queue/jobs.js';
import { RefundsService } from '../src/refunds/refunds.service.js';
import type { FakeStripe } from './fake-stripe.js';
import {
  createOrder,
  createTestApp,
  createTestWorker,
  payOrder,
  resetDb,
  seedProduct,
} from './helpers.js';
import { piEvent, postWebhook, refundEvent } from './webhooks.js';

describe('refunds', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let server: Server;
  let db: Db;
  let stripe: FakeStripe;
  let service: RefundsService;
  let order: OrderView;

  const requestRefund = (
    orderId = order.id,
    key: string = crypto.randomUUID(),
    apiKey: string | null = 'test-admin-key',
  ) => {
    const req = request(server)
      .post(`/orders/${orderId}/refunds`)
      .set('Idempotency-Key', key);
    if (apiKey) req.set('x-api-key', apiKey);
    return req;
  };
  const statusOf = async () =>
    (await db.select().from(orders).where(eq(orders.id, order.id)))[0].status;
  const setStatus = (status: OrderStatus) =>
    db.update(orders).set({ status }).where(eq(orders.id, order.id));
  const refundRows = () => db.select().from(refunds);
  const outboxTypes = async () =>
    (await db.select().from(outbox)).map((r) => r.eventType);

  beforeAll(async () => {
    ({ app, db, stripe } = await createTestApp());
    ({ worker } = await createTestWorker(stripe));
    server = app.getHttpServer();
    service = app.get(RefundsService);
  });
  beforeEach(async () => {
    await resetDb(db);
    stripe.refundStatus = 'succeeded';
    order = await createOrder(
      app,
      await seedProduct(db, { priceCents: 3000, stock: 5 }),
    );
  });
  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  describe('admin endpoint', () => {
    it('accepts a refund for a paid order (202) and queues it via the outbox', async () => {
      await payOrder(app, stripe, order);

      const res = await requestRefund().expect(202);

      expect(res.body).toEqual({
        refundId: expect.any(String),
        status: 'requested',
      });
      expect(await statusOf()).toBe('refund_pending');
      expect(await refundRows()).toMatchObject([
        {
          id: res.body.refundId,
          reason: 'admin',
          status: 'requested',
          amountCents: 3000,
          previousOrderStatus: 'paid',
        },
      ]);
      expect(await outboxTypes()).toContain('refund.requested');
    });

    it('401 without x-api-key or with a wrong one', async () => {
      await payOrder(app, stripe, order);
      await requestRefund(order.id, 'k', null).expect(401);
      await requestRefund(order.id, 'k', 'wrong').expect(401);
    });

    it('400 for a non-uuid id, 404 for an unknown order', async () => {
      await requestRefund('nope').expect(400);
      await requestRefund(crypto.randomUUID()).expect(404);
    });

    it('409 for an order that was never paid', async () => {
      const res = await requestRefund().expect(409);
      expect(res.body.code).toBe('order_not_refundable');
    });

    it('replays the response for a repeated Idempotency-Key', async () => {
      await payOrder(app, stripe, order);

      const first = await requestRefund(order.id, 'refund-key').expect(202);
      const second = await requestRefund(order.id, 'refund-key').expect(202);

      expect(second.body).toEqual(first.body);
      expect(await refundRows()).toHaveLength(1);
    });

    it('5 concurrent refund requests with different keys create exactly one refund', async () => {
      await payOrder(app, stripe, order);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => requestRefund()),
      );

      expect(results.filter((r) => r.status === 202)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await refundRows()).toHaveLength(1);
    });

    it('GET /orders/:id shows the refund', async () => {
      await payOrder(app, stripe, order);
      const { body } = await requestRefund().expect(202);

      const res = await request(server).get(`/orders/${order.id}`).expect(200);

      expect(res.body.refunds).toEqual([
        {
          id: body.refundId,
          status: 'requested',
          reason: 'admin',
          amountCents: 3000,
        },
      ]);
    });
  });

  describe('Stripe refund job', () => {
    it('refunds at Stripe with an idempotency key, then marks the order refunded', async () => {
      const piId = await payOrder(app, stripe, order);
      const { body } = await requestRefund().expect(202);

      await service.submitToStripe(body.refundId);

      const [refund] = await refundRows();
      expect(refund).toMatchObject({
        status: 'succeeded',
        stripeRefundId: expect.stringMatching(/^re_fake_/),
      });
      expect(await stripe.paymentIntents.retrieve(piId)).toBeDefined();
      expect(await statusOf()).toBe('refunded');
      expect(await outboxTypes()).toContain('order.refunded');
    });

    it('running the job twice refunds once and emits order.refunded once', async () => {
      await payOrder(app, stripe, order);
      const { body } = await requestRefund().expect(202);
      const before = stripe.calls['refunds.create'] ?? 0;

      await service.submitToStripe(body.refundId);
      await service.submitToStripe(body.refundId);

      expect(stripe.calls['refunds.create']).toBe(before + 1);
      expect(
        (await outboxTypes()).filter((t) => t === 'order.refunded'),
      ).toHaveLength(1);
    });

    it('a pending Stripe refund waits for the webhook, matched by metadata.refund_id', async () => {
      await payOrder(app, stripe, order);
      const { body } = await requestRefund().expect(202);
      stripe.refundStatus = 'pending';

      // The webhook can arrive before our stripe_refund_id write; metadata matches it anyway.
      await postWebhook(
        server,
        refundEvent('refund.updated', {
          id: 're_unsaved',
          status: 'succeeded',
          refundId: body.refundId,
        }),
      ).expect(200);

      expect(await statusOf()).toBe('refunded');
    });

    it('a failed refund puts a fulfilled order back to fulfilled and allows a new refund', async () => {
      await payOrder(app, stripe, order);
      await setStatus('fulfilled');
      const { body } = await requestRefund().expect(202);

      await postWebhook(
        server,
        refundEvent('refund.failed', {
          id: 're_1',
          status: 'failed',
          refundId: body.refundId,
        }),
      ).expect(200);

      expect(await statusOf()).toBe('fulfilled');
      expect((await refundRows())[0].status).toBe('failed');
      await requestRefund().expect(202);
    });

    it('a refund job that exhausts its retries marks the refund failed and restores the order', async () => {
      await payOrder(app, stripe, order);
      const { body } = await requestRefund().expect(202);

      await worker.get(JobsProcessor).onFailed({
        name: 'stripe-refund',
        data: { orderId: order.id, refundId: body.refundId },
        attemptsMade: 5,
        opts: { attempts: 5 },
      } as Job<JobData>);

      expect((await refundRows())[0].status).toBe('failed');
      expect(await statusOf()).toBe('paid');
    });

    it('a refund event without our metadata is acknowledged and ignored', async () => {
      await postWebhook(
        server,
        refundEvent('refund.updated', { id: 're_dash', status: 'succeeded' }),
      ).expect(200);
    });
  });

  describe('automatic refunds', () => {
    const succeeded = (amount: number, eventId?: string) =>
      piEvent(
        'payment_intent.succeeded',
        { id: 'pi_auto', amount, orderId: order.id },
        eventId,
      );

    it('refunds a payment whose amount does not match, and leaves the order pending', async () => {
      await postWebhook(server, succeeded(100)).expect(200);

      expect(await statusOf()).toBe('pending_payment');
      expect(await refundRows()).toMatchObject([
        {
          reason: 'amount_mismatch',
          amountCents: 100,
          stripePaymentIntentId: 'pi_auto',
        },
      ]);
      expect(await outboxTypes()).toEqual(['refund.requested']);
    });

    it('refunds a payment that lands on an expired order, which stays expired', async () => {
      await setStatus('expired');

      await postWebhook(server, succeeded(3000)).expect(200);

      expect(await statusOf()).toBe('expired');
      expect(await refundRows()).toMatchObject([{ reason: 'late_payment' }]);
    });

    it('two different late-payment events for one order still create one refund', async () => {
      await setStatus('expired');

      await postWebhook(server, succeeded(3000, 'evt_a')).expect(200);
      await postWebhook(server, succeeded(3000, 'evt_b')).expect(200);

      expect(await refundRows()).toHaveLength(1);
    });
  });
});
