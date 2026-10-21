import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, jobsQueue } from './helpers.js';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });
  afterAll(() => app.close());

  it('reports db and redis up', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up', redis: 'up' });
  });

  it('echoes x-request-id', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set('x-request-id', 'abc');
    expect(res.headers['x-request-id']).toBe('abc');
  });

  it('generates a request id when none is sent', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('503 instead of hanging when Redis does not answer', async () => {
    const queue = jobsQueue(app);
    const hang = vi
      .spyOn(queue, 'count')
      .mockReturnValue(new Promise(() => {}));

    const res = await request(app.getHttpServer()).get('/health').expect(503);

    hang.mockRestore();
    expect(res.body).toMatchObject({ db: 'up', redis: 'down' });
  });
});
