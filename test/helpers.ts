import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { DB, type Db } from '../src/db/db.module.js';
import { products } from '../src/db/schema.js';
import type { OrderView } from '../src/orders/orders.service.js';
import { STRIPE } from '../src/payments/stripe.module.js';
import { setupApp } from '../src/setup-app.js';
import { FakeStripe } from './fake-stripe.js';

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
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
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
