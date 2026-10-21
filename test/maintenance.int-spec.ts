import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Db } from '../src/db/db.module.js';
import {
  idempotencyKeys,
  orders,
  outbox,
  products,
  refunds,
  webhookEvents,
} from '../src/db/schema.js';
import {
  HARD_EXPIRY_GRACE_MS,
  MaintenanceService,
} from '../src/maintenance/maintenance.service.js';
import type { OrderView } from '../src/orders/orders.service.js';
import type { FakeStripe } from './fake-stripe.js';
import {
  createOrder,
  createTestApp,
  createTestWorker,
  resetDb,
  seedProduct,
} from './helpers.js';
import { piEvent, postWebhook } from './webhooks.js';

describe('maintenance', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let db: Db;
  let stripe: FakeStripe;
  let maintenance: MaintenanceService;
  let productId: number;
  let order: OrderView;

  const afterExpiry = (ms = 1000) =>
    new Date(new Date(order.expiresAt).getTime() + ms);
  const statusOf = async () =>
    (await db.select().from(orders).where(eq(orders.id, order.id)))[0].status;
  const stock = async () =>
    (await db.select().from(products).where(eq(products.id, productId)))[0]
      .stock;
  const attachIntent = async (): Promise<string> =>
    (
      await request(app.getHttpServer())
        .post(`/orders/${order.id}/payment-intent`)
        .expect(200)
    ).body.paymentIntentId;

  beforeAll(async () => {
    ({ app, db, stripe } = await createTestApp());
    ({ worker } = await createTestWorker(stripe));
    maintenance = worker.get(MaintenanceService);
  });
  beforeEach(async () => {
    await resetDb(db);
    productId = await seedProduct(db, { priceCents: 1000, stock: 5 });
    order = await createOrder(app, productId, 2);
  });
  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  describe('expiry sweeper', () => {
    it('expires an overdue unpaid order and returns its stock', async () => {
      expect(await stock()).toBe(3);

      const result = await maintenance.sweepExpiredOrders(afterExpiry());

      expect(result).toEqual({ expired: 1, skipped: 0 });
      expect(await statusOf()).toBe('expired');
      expect(await stock()).toBe(5);
      expect((await db.select().from(outbox)).map((r) => r.eventType)).toEqual([
        'order.expired',
      ]);
    });

    it('leaves orders that are not yet due', async () => {
      const result = await maintenance.sweepExpiredOrders(new Date());

      expect(result).toEqual({ expired: 0, skipped: 0 });
      expect(await statusOf()).toBe('pending_payment');
    });

    it('cancels an unpaid PaymentIntent before expiring, so it can no longer be paid', async () => {
      const piId = await attachIntent();

      await maintenance.sweepExpiredOrders(afterExpiry());

      expect((await stripe.paymentIntents.retrieve(piId)).status).toBe(
        'canceled',
      );
      expect(await statusOf()).toBe('expired');
    });

    it('waits for a processing payment until the hard deadline, then expires', async () => {
      const piId = await attachIntent();
      stripe.setIntentStatus(piId, 'processing');

      expect(await maintenance.sweepExpiredOrders(afterExpiry())).toEqual({
        expired: 0,
        skipped: 1,
      });
      expect(await statusOf()).toBe('pending_payment');

      await maintenance.sweepExpiredOrders(
        afterExpiry(HARD_EXPIRY_GRACE_MS + 60_000),
      );
      expect(await statusOf()).toBe('expired');
      expect(await stock()).toBe(5);
    });

    it('two sweepers running at once return the stock exactly once', async () => {
      await Promise.all([
        maintenance.sweepExpiredOrders(afterExpiry()),
        maintenance.sweepExpiredOrders(afterExpiry()),
      ]);

      expect(await stock()).toBe(5);
    });

    it('leaves the order pending when Stripe is unreachable, without throwing', async () => {
      await attachIntent();
      stripe.failNext('paymentIntents.retrieve');

      const result = await maintenance.sweepExpiredOrders(afterExpiry());

      expect(result).toEqual({ expired: 0, skipped: 1 });
      expect(await statusOf()).toBe('pending_payment');
    });

    it('race: the sweeper expires the order, then the payment lands, and it is refunded', async () => {
      const piId = await attachIntent();
      await maintenance.sweepExpiredOrders(afterExpiry());

      await postWebhook(
        app.getHttpServer(),
        piEvent('payment_intent.succeeded', {
          id: piId,
          amount: order.totalCents,
          orderId: order.id,
        }),
      ).expect(200);

      expect(await statusOf()).toBe('expired');
      expect(await db.select().from(refunds)).toMatchObject([
        { reason: 'late_payment', amountCents: order.totalCents },
      ]);
    });
  });

  describe('retention pruning', () => {
    it('deletes week-old keys, webhook events and published outbox rows, keeping the rest', async () => {
      const old = new Date(Date.now() - 8 * 24 * 3600_000);
      await db.insert(idempotencyKeys).values([
        { key: 'old', endpoint: 'e', requestHash: 'h', createdAt: old },
        { key: 'new', endpoint: 'e', requestHash: 'h' },
      ]);
      await db.insert(webhookEvents).values([
        { stripeEventId: 'evt_old', type: 't', payload: {}, receivedAt: old },
        { stripeEventId: 'evt_new', type: 't', payload: {} },
      ]);
      await db.insert(outbox).values([
        { eventType: 'a', aggregateId: 'x', payload: {}, publishedAt: old },
        { eventType: 'b', aggregateId: 'x', payload: {}, createdAt: old },
        {
          eventType: 'c',
          aggregateId: 'x',
          payload: {},
          publishedAt: new Date(),
        },
      ]);

      await maintenance.pruneOldRecords();

      // order creation in beforeEach stored one more idempotency key
      expect(
        (await db.select().from(idempotencyKeys)).map((r) => r.key),
      ).not.toContain('old');
      expect(
        (await db.select().from(webhookEvents)).map((r) => r.stripeEventId),
      ).toEqual(['evt_new']);
      expect(
        (await db.select().from(outbox)).map((r) => r.eventType).sort(),
      ).toEqual(['b', 'c']);
    });
  });
});
