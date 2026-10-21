import { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { isNull } from 'drizzle-orm';
import type { Db } from '../src/db/db.module.js';
import { outbox } from '../src/db/schema.js';
import { OutboxRelayService } from '../src/outbox/outbox-relay.service.js';
import { enqueueOutbox, type OutboxEvent } from '../src/outbox/outbox.js';
import { createTestApp, jobsQueue, resetDb, resetQueue } from './helpers.js';

describe('outbox relay', () => {
  let app: INestApplication;
  let db: Db;
  let queue: Queue;
  let relay: OutboxRelayService;
  const write = (event: OutboxEvent, orderId: string) =>
    db.transaction((tx) => enqueueOutbox(tx, event, orderId, { orderId }));
  const queuedJobs = async () =>
    (await queue.getJobs(['waiting', 'delayed', 'prioritized'])).map((j) => ({
      id: j.id,
      name: j.name,
      data: j.data,
    }));

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    queue = jobsQueue(app);
    relay = app.get(OutboxRelayService);
  });
  beforeEach(async () => {
    await resetDb(db);
    await resetQueue(queue);
  });
  afterAll(() => app.close());

  it('publishes each outbox row as the jobs mapped to its event and marks it published', async () => {
    await write('order.paid', 'order-1');
    await write('refund.requested', 'order-2');

    expect(await relay.relayOnce()).toBe(2);

    const jobs = await queuedJobs();
    expect(jobs.map((j) => j.id).sort()).toEqual([
      '1-email-order-confirmation',
      '1-fulfill-order',
      '2-stripe-refund',
    ]);
    expect(jobs.find((j) => j.name === 'fulfill-order')?.data).toEqual({
      orderId: 'order-1',
    });
    expect(
      await db.select().from(outbox).where(isNull(outbox.publishedAt)),
    ).toHaveLength(0);
  });

  it('events without jobs (order.expired) are marked published without enqueueing', async () => {
    await write('order.expired', 'order-1');

    expect(await relay.relayOnce()).toBe(1);
    expect(await queuedJobs()).toHaveLength(0);
  });

  it('a crash after enqueue but before marking published does not duplicate jobs', async () => {
    await write('order.paid', 'order-1');
    await relay.relayOnce();

    // Simulate the crash: the rows look unpublished again.
    await db.update(outbox).set({ publishedAt: null });
    await relay.relayOnce();

    expect(await queuedJobs()).toHaveLength(2);
  });

  it('two relays running at once publish each row exactly once', async () => {
    for (let i = 0; i < 20; i++) await write('order.paid', `order-${i}`);

    const published = await Promise.all([relay.relayOnce(), relay.relayOnce()]);

    expect(published[0] + published[1]).toBe(20);
    expect(await queuedJobs()).toHaveLength(40);
  });
});
