import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Db } from '../src/db/db.module.js';
import { orders } from '../src/db/schema.js';
import type { FakeStripe } from './fake-stripe.js';
import { createOrder, createTestApp, resetDb, seedProduct } from './helpers.js';

describe('POST /orders/:id/payment-intent', () => {
  let app: INestApplication;
  let db: Db;
  let stripe: FakeStripe;
  let productId: number;
  const start = (orderId: string) =>
    request(app.getHttpServer()).post(`/orders/${orderId}/payment-intent`);
  const orderRow = async (id: string) =>
    (await db.select().from(orders).where(eq(orders.id, id)))[0];

  beforeAll(async () => {
    ({ app, db, stripe } = await createTestApp());
  });
  beforeEach(async () => {
    await resetDb(db);
    productId = await seedProduct(db, { priceCents: 2500, stock: 10 });
  });
  afterAll(() => app.close());

  it('creates a PaymentIntent for the order total and saves its id', async () => {
    const order = await createOrder(app, productId, 2);

    const res = await start(order.id).expect(200);

    const intent = await stripe.paymentIntents.retrieve(
      res.body.paymentIntentId,
    );
    expect(intent).toMatchObject({
      amount: 5000,
      currency: 'usd',
      metadata: { order_id: order.id },
    });
    expect(res.body.clientSecret).toBe(intent.client_secret);
    expect((await orderRow(order.id)).stripePaymentIntentId).toBe(intent.id);
  });

  it('returns the same PaymentIntent on a second call without creating another', async () => {
    const order = await createOrder(app, productId);
    const createsBefore = stripe.calls['paymentIntents.create'] ?? 0;

    const first = await start(order.id).expect(200);
    const second = await start(order.id).expect(200);

    expect(second.body).toEqual(first.body);
    expect(stripe.calls['paymentIntents.create']).toBe(createsBefore + 1);
  });

  it('concurrent calls all get the same PaymentIntent', async () => {
    const order = await createOrder(app, productId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => start(order.id)),
    );

    expect(results.map((r) => r.status)).toEqual(Array(5).fill(200));
    expect(new Set(results.map((r) => r.body.paymentIntentId)).size).toBe(1);
  });

  it('409 when the order is past its expiry time', async () => {
    const order = await createOrder(app, productId);
    await db
      .update(orders)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(orders.id, order.id));

    const res = await start(order.id).expect(409);

    expect(res.body.code).toBe('order_not_payable');
  });

  it('409 when the order is no longer pending payment', async () => {
    const order = await createOrder(app, productId);
    await db
      .update(orders)
      .set({ status: 'paid' })
      .where(eq(orders.id, order.id));

    await start(order.id).expect(409);
  });

  it('502 when Stripe is down; a retry after recovery creates exactly one PaymentIntent', async () => {
    const order = await createOrder(app, productId);
    stripe.failNext('paymentIntents.create');

    const failed = await start(order.id).expect(502);
    expect(failed.body.code).toBe('payment_provider_unavailable');
    expect((await orderRow(order.id)).stripePaymentIntentId).toBeNull();

    const ok = await start(order.id).expect(200);
    expect((await orderRow(order.id)).stripePaymentIntentId).toBe(
      ok.body.paymentIntentId,
    );
  });

  it('a Stripe rejection (e.g. invalid API key) is a 500, not "unavailable, please retry"', async () => {
    const order = await createOrder(app, productId);
    stripe.failNext('paymentIntents.create', 1, 'auth');

    const res = await start(order.id).expect(500);

    expect(res.body.code).toBe('payment_provider_error');
    expect((await orderRow(order.id)).stripePaymentIntentId).toBeNull();
  });

  it('400 for a non-uuid id, 404 for an unknown order', async () => {
    await start('nope').expect(400);
    await start(crypto.randomUUID()).expect(404);
  });
});
