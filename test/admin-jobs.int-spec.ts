import { INestApplication } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import request from 'supertest';
import { JOBS_QUEUE, redisConnection } from '../src/queue/jobs.js';
import { createTestApp, jobsQueue, resetQueue } from './helpers.js';

describe('admin job endpoints', () => {
  let app: INestApplication;
  let queue: Queue;
  const asAdmin = (req: request.Test) => req.set('x-api-key', 'test-admin-key');

  /** Runs one job through a throwaway worker that always fails, with no retries. */
  async function createFailedJob(): Promise<string> {
    const job = await queue.add(
      'fulfill-order',
      { orderId: 'o-1' },
      { attempts: 1 },
    );
    const worker = new Worker(
      JOBS_QUEUE,
      async () => {
        throw new Error('fulfillment provider down');
      },
      { connection: redisConnection(process.env.REDIS_URL!) },
    );
    await new Promise((resolve) => worker.on('failed', resolve));
    await worker.close();
    return job.id!;
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    queue = jobsQueue(app);
  });
  beforeEach(() => resetQueue(queue));
  afterAll(() => app.close());

  it('401 without an API key or with a wrong one', async () => {
    const server = app.getHttpServer();
    await request(server).get('/admin/jobs/failed').expect(401);
    await request(server)
      .get('/admin/jobs/failed')
      .set('x-api-key', 'wrong')
      .expect(401);
  });

  it('lists failed jobs with their failure reason', async () => {
    const id = await createFailedJob();

    const res = await asAdmin(
      request(app.getHttpServer()).get('/admin/jobs/failed'),
    ).expect(200);

    expect(res.body).toMatchObject([
      {
        id,
        name: 'fulfill-order',
        data: { orderId: 'o-1' },
        attemptsMade: 1,
        failedReason: 'fulfillment provider down',
      },
    ]);
  });

  it('retries a failed job by moving it back to waiting', async () => {
    const id = await createFailedJob();

    await asAdmin(
      request(app.getHttpServer()).post(`/admin/jobs/${id}/retry`),
    ).expect(202);

    expect(await (await queue.getJob(id))?.getState()).toBe('waiting');
  });

  it('404 when retrying an unknown job', async () => {
    await asAdmin(
      request(app.getHttpServer()).post('/admin/jobs/nope/retry'),
    ).expect(404);
  });
});
