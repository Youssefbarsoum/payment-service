import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import type { Mock } from 'vitest';
import { MAIL_TRANSPORT } from '../src/email/email.service.js';
import { JOBS_QUEUE } from '../src/queue/jobs.js';
import { WorkerModule } from '../src/worker.module.js';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { DB, type Db } from '../src/db/db.module.js';
import { products } from '../src/db/schema.js';
import type { OrderView } from '../src/orders/orders.service.js';
import { STRIPE } from '../src/payments/stripe.module.js';
import { setupApp } from '../src/setup-app.js';
import { FakeStripe } from './fake-stripe.js';
import { piEvent, postWebhook } from './webhooks.js';

export async function createTestApp(): Promise<{
  app: INestApplication;
  db: Db;
  stripe: FakeStripe;
}> {
  const stripe = new FakeStripe();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(STRIPE)
    .useValue(stripe)
    .compile();
  const app = moduleRef.createNestApplication({
    rawBody: true,
    logger: false,
  });
  setupApp(app);
  await app.init();
  return { app, db: app.get<Db>(DB), stripe };
}

export async function resetDb(db: Db): Promise<void> {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await db.execute(sql.raw(`truncate ${tables} restart identity cascade`));
}

export async function seedProduct(
  db: Db,
  p: { name?: string; priceCents: number; stock: number },
): Promise<number> {
  const [row] = await db
    .insert(products)
    .values({ ...p, name: p.name ?? `product-${crypto.randomUUID()}` })
    .returning({ id: products.id });
  return row.id;
}

/** Boots the worker process's module graph with Stripe and SMTP faked. */
export async function createTestWorker(stripe = new FakeStripe()): Promise<{
  worker: INestApplicationContext;
  db: Db;
  stripe: FakeStripe;
  mail: { sendMail: Mock };
}> {
  const mail = { sendMail: vi.fn().mockResolvedValue({}) };
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(STRIPE)
    .useValue(stripe)
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(mail)
    .compile();
  // A TestingModule is itself an application context; init() runs lifecycle hooks.
  moduleRef.useLogger(false);
  await moduleRef.init();
  return { worker: moduleRef, db: moduleRef.get<Db>(DB), stripe, mail };
}

export function jobsQueue(app: INestApplicationContext): Queue {
  return app.get<Queue>(getQueueToken(JOBS_QUEUE));
}

export async function resetQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}

/** Creates an order through the API, as a client would. */
export async function createOrder(
  app: INestApplication,
  productId: number,
  quantity = 1,
): Promise<OrderView> {
  const res = await request(app.getHttpServer())
    .post('/orders')
    .set('Idempotency-Key', crypto.randomUUID())
    .send({ email: 'buyer@example.com', items: [{ productId, quantity }] })
    .expect(201);
  return res.body as OrderView;
}

/**
 * Takes an order through the real payment path: PaymentIntent endpoint, the
 * customer paying at Stripe, then the signed payment_intent.succeeded webhook.
 */
export async function payOrder(
  app: INestApplication,
  stripe: FakeStripe,
  order: OrderView,
): Promise<string> {
  const server = app.getHttpServer();
  const res = await request(server)
    .post(`/orders/${order.id}/payment-intent`)
    .expect(200);
  const piId: string = res.body.paymentIntentId;
  stripe.setIntentStatus(piId, 'succeeded');
  await postWebhook(
    server,
    piEvent('payment_intent.succeeded', {
      id: piId,
      amount: order.totalCents,
      orderId: order.id,
    }),
  ).expect(200);
  return piId;
}
