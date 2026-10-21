import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Db } from '../src/db/db.module.js';
import { orders, products } from '../src/db/schema.js';
import { createTestApp, resetDb, seedProduct } from './helpers.js';

describe('idempotency keys on POST /orders', () => {
  let app: INestApplication;
  let db: Db;
  let productId: number;
  const body = () => ({
    email: 'buyer@example.com',
    items: [{ productId, quantity: 1 }],
  });
  const post = (key: string | undefined, payload: object = body()) => {
    const req = request(app.getHttpServer()).post('/orders');
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(payload);
  };
  const stock = async () =>
    (await db.select().from(products).where(eq(products.id, productId)))[0]
      .stock;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });
  beforeEach(async () => {
    await resetDb(db);
    productId = await seedProduct(db, { priceCents: 1000, stock: 10 });
  });
  afterAll(() => app.close());

  it('replays the stored response for a repeated key', async () => {
    const first = await post('key-1').expect(201);
    const second = await post('key-1').expect(201);

    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(await db.select().from(orders)).toHaveLength(1);
    expect(await stock()).toBe(9);
  });

  it('10 concurrent requests with one key create exactly one order', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post('same-key')),
    );

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await db.select().from(orders)).toHaveLength(1);
    expect(await stock()).toBe(9);
  });

  it('rejects the same key with a different body (422)', async () => {
    await post('key-2').expect(201);

    const res = await post('key-2', { ...body(), email: 'other@example.com' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('idempotency_key_mismatch');
    expect(await db.select().from(orders)).toHaveLength(1);
  });

  it('does not store failures: the same key succeeds once stock returns', async () => {
    await db.update(products).set({ stock: 0 });
    await post('key-3').expect(409);

    await db.update(products).set({ stock: 1 });
    await post('key-3').expect(201);
  });

  it('400 when the Idempotency-Key header is missing, and no order is created', async () => {
    const res = await post(undefined).expect(400);

    expect(res.body.code).toBe('idempotency_key_required');
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it('400 when the key is longer than 255 characters', async () => {
    await post('k'.repeat(256)).expect(400);
    expect(await db.select().from(orders)).toHaveLength(0);
  });
});
