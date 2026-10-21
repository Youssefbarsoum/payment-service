import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './helpers.js';

describe('presentation endpoints', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });
  afterAll(() => app.close());

  it('documents POST /orders with its required Idempotency-Key header', async () => {
    const res = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);

    const params = res.body.paths['/orders'].post.parameters;
    expect(params).toContainEqual(
      expect.objectContaining({
        in: 'header',
        name: 'Idempotency-Key',
        required: true,
      }),
    );
    expect(res.body.components.schemas.CreateOrderDto).toBeDefined();
  });

  it('GET /checkout-config returns the Stripe publishable key', async () => {
    const res = await request(app.getHttpServer())
      .get('/checkout-config')
      .expect(200);

    expect(res.body).toEqual({ publishableKey: 'pk_test_dummy' });
  });

  it('serves the test checkout page', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);
    expect(res.text).toContain('<title>Checkout</title>');
  });
});
