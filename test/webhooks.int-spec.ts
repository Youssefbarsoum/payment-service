import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Server } from 'node:http';
import type { Db } from '../src/db/db.module.js';
import { orders, outbox, payments, webhookEvents } from '../src/db/schema.js';
import type { OrderView } from '../src/orders/orders.service.js';
import { WebhookHandlerService } from '../src/payments/webhook-handler.service.js';
import { createOrder, createTestApp, resetDb, seedProduct } from './helpers.js';
import { piEvent, postWebhook } from './webhooks.js';

describe('POST /webhooks/stripe', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let order: OrderView;
  const succeeded = (amount = order.totalCents, eventId?: string) =>
    piEvent(
      'payment_intent.succeeded',
      { id: 'pi_1', amount, orderId: order.id },
      eventId,
    );
  const failed = (eventId?: string) =>
    piEvent(
      'payment_intent.payment_failed',
      { id: 'pi_1', amount: order.totalCents, orderId: order.id },
      eventId,
    );
  const statusOf = async () =>
    (await db.select().from(orders).where(eq(orders.id, order.id)))[0].status;
  const outboxTypes = async () =>
    (await db.select().from(outbox)).map((r) => r.eventType);

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    server = app.getHttpServer();
  });
  beforeEach(async () => {
    await resetDb(db);
    order = await createOrder(
      app,
      await seedProduct(db, { priceCents: 4200, stock: 5 }),
    );
  });
  afterAll(() => app.close());

  it('payment_intent.succeeded marks the order paid and writes one order.paid outbox event', async () => {
    const res = await postWebhook(server, succeeded()).expect(200);

    expect(res.body).toEqual({ received: true });
    expect(await statusOf()).toBe('paid');
    expect(await db.select().from(payments)).toMatchObject([
      { orderId: order.id, amountCents: 4200, status: 'succeeded' },
    ]);
    const [event] = await db.select().from(outbox);
    expect(event).toMatchObject({
      eventType: 'order.paid',
      aggregateId: order.id,
      payload: { orderId: order.id },
    });
  });

  it('processes the same event only once when delivered twice', async () => {
    const event = succeeded();

    await postWebhook(server, event).expect(200);
    await postWebhook(server, event).expect(200);

    expect(await db.select().from(payments)).toHaveLength(1);
    expect(await outboxTypes()).toEqual(['order.paid']);
  });

  it('processes the same event only once when delivered 5 times concurrently', async () => {
    const event = succeeded();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => postWebhook(server, event)),
    );

    expect(results.map((r) => r.status)).toEqual(Array(5).fill(200));
    expect(await db.select().from(payments)).toHaveLength(1);
    expect(await outboxTypes()).toEqual(['order.paid']);
  });

  it('ignores a payment_failed that arrives after succeeded (out of order)', async () => {
    await postWebhook(server, succeeded()).expect(200);
    await postWebhook(server, failed()).expect(200);

    expect(await statusOf()).toBe('paid');
    expect(await outboxTypes()).toEqual(['order.paid']);
  });

  it('payment_failed keeps the order pending and emits payment.failed', async () => {
    await postWebhook(server, failed()).expect(200);

    expect(await statusOf()).toBe('pending_payment');
    expect(await db.select().from(payments)).toMatchObject([
      { status: 'failed' },
    ]);
    expect(await outboxTypes()).toEqual(['payment.failed']);
  });

  it('does not mark paid when the amount does not match the order', async () => {
    await postWebhook(server, succeeded(100)).expect(200);

    expect(await statusOf()).toBe('pending_payment');
    expect(await db.select().from(payments)).toMatchObject([
      { amountCents: 100, status: 'succeeded' },
    ]);
    expect(await outboxTypes()).not.toContain('order.paid');
  });

  it('400 without a stripe-signature header, and stores nothing', async () => {
    const res = await postWebhook(server, succeeded(), {
      signature: null,
    }).expect(400);

    expect(res.body.code).toBe('invalid_signature');
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it('400 when signed with the wrong secret', async () => {
    await postWebhook(server, succeeded(), { secret: 'whsec_wrong' }).expect(
      400,
    );
    expect(await statusOf()).toBe('pending_payment');
  });

  it('400 when the body was re-serialized after signing', async () => {
    const event = succeeded();
    await postWebhook(server, event, {
      body: JSON.stringify(event, null, 2),
    }).expect(400);
    expect(await statusOf()).toBe('pending_payment');
  });

  it('stores and acknowledges unknown event types without changing state', async () => {
    const event = { ...succeeded(), type: 'customer.created' } as never;

    await postWebhook(server, event).expect(200);

    expect(await db.select().from(webhookEvents)).toHaveLength(1);
    expect(await statusOf()).toBe('pending_payment');
  });

  it('acknowledges events for unknown orders without retry loops', async () => {
    const event = piEvent('payment_intent.succeeded', {
      id: 'pi_x',
      amount: 100,
      orderId: 'not-a-uuid',
    });

    await postWebhook(server, event).expect(200);
    expect(await db.select().from(payments)).toHaveLength(0);
  });

  it('rolls back the dedupe record when handling fails, so redelivery reprocesses', async () => {
    const handler = app.get(WebhookHandlerService);
    const spy = vi
      .spyOn(handler as never, 'onPaymentSucceeded')
      .mockRejectedValueOnce(new Error('boom') as never);
    const event = succeeded();

    await postWebhook(server, event).expect(500);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);

    await postWebhook(server, event).expect(200);
    expect(await statusOf()).toBe('paid');
    spy.mockRestore();
  });
});
