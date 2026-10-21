import { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Mock } from 'vitest';
import type { Db } from '../src/db/db.module.js';
import { orders } from '../src/db/schema.js';
import { JobsProcessor } from '../src/jobs/jobs.processor.js';
import type { OrderStatus } from '../src/orders/order-status.js';
import type { OrderView } from '../src/orders/orders.service.js';
import type { JobData, JobName } from '../src/queue/jobs.js';
import {
  createOrder,
  createTestApp,
  createTestWorker,
  resetDb,
  seedProduct,
} from './helpers.js';

describe('worker jobs', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let db: Db;
  let mail: { sendMail: Mock };
  let processor: JobsProcessor;
  let order: OrderView;

  const run = (name: JobName, id = `1-${name}`) =>
    processor.process({
      id,
      name,
      data: { orderId: order.id },
      attemptsMade: 0,
    } as Job<JobData, unknown, JobName>);
  const setStatus = (status: OrderStatus) =>
    db.update(orders).set({ status }).where(eq(orders.id, order.id));
  const statusOf = async () =>
    (await db.select().from(orders).where(eq(orders.id, order.id)))[0].status;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    ({ worker, mail } = await createTestWorker());
    processor = worker.get(JobsProcessor);
  });
  beforeEach(async () => {
    await resetDb(db);
    mail.sendMail.mockClear();
    order = await createOrder(
      app,
      await seedProduct(db, { priceCents: 1000, stock: 5 }),
    );
  });
  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  it('fulfill-order moves a paid order to fulfilled; a second run is a no-op', async () => {
    await setStatus('paid');

    await run('fulfill-order');
    await run('fulfill-order');

    expect(await statusOf()).toBe('fulfilled');
  });

  it('fulfill-order leaves a refund_pending order alone', async () => {
    await setStatus('refund_pending');

    await run('fulfill-order');

    expect(await statusOf()).toBe('refund_pending');
  });

  it('sends the confirmation email once even when the job runs twice', async () => {
    await run('email-order-confirmation');
    await run('email-order-confirmation');

    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(mail.sendMail.mock.calls[0][0]).toMatchObject({
      to: 'buyer@example.com',
      subject: `Order confirmed — #${order.id.slice(0, 8)}`,
    });
  });

  it('sends one payment-failed email per failure event', async () => {
    await run('email-payment-failed', '1-email-payment-failed');
    await run('email-payment-failed', '2-email-payment-failed');

    expect(mail.sendMail).toHaveBeenCalledTimes(2);
  });

  it('a failing SMTP send throws so BullMQ retries, and nothing is recorded as sent', async () => {
    mail.sendMail.mockRejectedValueOnce(new Error('SMTP down'));

    await expect(run('email-order-confirmation')).rejects.toThrow('SMTP down');
    await run('email-order-confirmation');

    expect(mail.sendMail).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown job names', async () => {
    await expect(run('nope' as JobName)).rejects.toThrow(/Unknown job/);
  });
});
