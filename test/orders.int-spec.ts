import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Db } from '../src/db/db.module.js';
import { orders, products } from '../src/db/schema.js';
import { createTestApp, resetDb, seedProduct } from './helpers.js';

describe('orders', () => {
  let app: INestApplication;
  let db: Db;
  const post = (body: unknown) =>
    request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', crypto.randomUUID())
      .send(body as object);
  const stockOf = async (id: number) =>
    (await db.select().from(products).where(eq(products.id, id)))[0].stock;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });
  beforeEach(() => resetDb(db));
  afterAll(() => app.close());

  it('creates an order, snapshots prices and decrements stock', async () => {
    const id = await seedProduct(db, { priceCents: 1500, stock: 5 });

    const res = await post({
      email: 'buyer@example.com',
      items: [{ productId: id, quantity: 2 }],
    }).expect(201);

    expect(res.body).toMatchObject({
      status: 'pending_payment',
      customerEmail: 'buyer@example.com',
      totalCents: 3000,
      currency: 'usd',
      items: [{ productId: id, quantity: 2, unitPriceCents: 1500 }],
    });
    const ttl = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(15 * 60_000 - 5000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    expect(await stockOf(id)).toBe(3);
  });

  it('rejects when stock is insufficient and reserves nothing', async () => {
    const a = await seedProduct(db, { priceCents: 100, stock: 5 });
    const b = await seedProduct(db, { priceCents: 100, stock: 1 });

    const res = await post({
      email: 'buyer@example.com',
      items: [
        { productId: a, quantity: 2 },
        { productId: b, quantity: 2 },
      ],
    }).expect(409);

    expect(res.body.code).toBe('out_of_stock');
    expect(await stockOf(a)).toBe(5);
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it('20 concurrent orders for the last item: exactly one wins', async () => {
    const id = await seedProduct(db, { priceCents: 100, stock: 1 });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post({
          email: `buyer${i}@example.com`,
          items: [{ productId: id, quantity: 1 }],
        }),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    expect(await stockOf(id)).toBe(0);
    expect(await db.select().from(orders)).toHaveLength(1);
  });

  it('concurrent multi-item orders in opposite item order do not deadlock', async () => {
    const a = await seedProduct(db, { priceCents: 100, stock: 50 });
    const b = await seedProduct(db, { priceCents: 100, stock: 50 });
    const body = (first: number, second: number) => ({
      email: 'buyer@example.com',
      items: [
        { productId: first, quantity: 1 },
        { productId: second, quantity: 1 },
      ],
    });

    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => post(body(a, b))),
      ...Array.from({ length: 20 }, () => post(body(b, a))),
    ]);

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await stockOf(a)).toBe(10);
    expect(await stockOf(b)).toBe(10);
  });

  it.each([
    [
      'invalid email',
      { email: 'nope', items: [{ productId: 1, quantity: 1 }] },
    ],
    ['empty items', { email: 'a@b.co', items: [] }],
    ['quantity 0', { email: 'a@b.co', items: [{ productId: 1, quantity: 0 }] }],
    [
      'quantity 11',
      { email: 'a@b.co', items: [{ productId: 1, quantity: 11 }] },
    ],
    [
      'duplicate productId',
      {
        email: 'a@b.co',
        items: [
          { productId: 1, quantity: 1 },
          { productId: 1, quantity: 2 },
        ],
      },
    ],
    [
      'unknown field',
      { email: 'a@b.co', items: [{ productId: 1, quantity: 1 }], total: 0 },
    ],
  ])('400 on malformed body: %s', async (_, body) => {
    await seedProduct(db, { priceCents: 100, stock: 5 });
    await post(body).expect(400);
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it('404 on unknown productId with no stock touched', async () => {
    const a = await seedProduct(db, { priceCents: 100, stock: 5 });

    const res = await post({
      email: 'a@b.co',
      items: [
        { productId: a, quantity: 1 },
        { productId: 9999, quantity: 1 },
      ],
    }).expect(404);

    expect(res.body.code).toBe('product_not_found');
    expect(await stockOf(a)).toBe(5);
  });

  it('GET /orders/:id: 400 non-uuid, 404 unknown, 200 existing', async () => {
    const id = await seedProduct(db, { priceCents: 100, stock: 5 });
    const created = await post({
      email: 'a@b.co',
      items: [{ productId: id, quantity: 1 }],
    }).expect(201);
    const server = app.getHttpServer();

    await request(server).get('/orders/not-a-uuid').expect(400);
    await request(server).get(`/orders/${crypto.randomUUID()}`).expect(404);
    const res = await request(server)
      .get(`/orders/${created.body.id}`)
      .expect(200);
    expect(res.body).toEqual(created.body);
  });

  it('GET /products lists products with stock', async () => {
    await seedProduct(db, { name: 'Widget', priceCents: 250, stock: 3 });

    const res = await request(app.getHttpServer()).get('/products').expect(200);

    expect(res.body).toEqual([
      { id: 1, name: 'Widget', priceCents: 250, stock: 3 },
    ]);
  });
});
