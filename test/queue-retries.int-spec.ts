import { Queue, QueueEvents, Worker } from 'bullmq';
import { JOB_DEFAULTS, redisConnection } from '../src/queue/jobs.js';

// Verifies the retry policy every production job gets: 5 attempts with
// exponential backoff, and exhausted jobs kept in the failed set (our DLQ).
describe('job retry policy', () => {
  const connection = redisConnection(process.env.REDIS_URL!);
  const name = `retry-test-${crypto.randomUUID()}`;
  let queue: Queue;
  let events: QueueEvents;
  let worker: Worker | undefined;
  const fastRetries = {
    ...JOB_DEFAULTS,
    backoff: { type: 'exponential', delay: 10 },
  };

  beforeAll(async () => {
    queue = new Queue(name, { connection });
    events = new QueueEvents(name, { connection });
    await events.waitUntilReady();
  });
  afterEach(() => worker?.close());
  afterAll(async () => {
    await queue.obliterate({ force: true });
    await Promise.all([queue.close(), events.close()]);
  });

  it('defaults to 5 attempts and keeps failed jobs', () => {
    expect(JOB_DEFAULTS).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnFail: false,
    });
  });

  it('a job that fails twice then succeeds completes on attempt 3', async () => {
    let calls = 0;
    worker = new Worker(
      name,
      async () => {
        if (++calls < 3) throw new Error(`transient failure ${calls}`);
        return 'done';
      },
      { connection },
    );

    const job = await queue.add('flaky', {}, fastRetries);
    await expect(job.waitUntilFinished(events)).resolves.toBe('done');

    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(3);
  });

  it('a job that always fails ends in the failed set after 5 attempts', async () => {
    worker = new Worker(
      name,
      async () => {
        throw new Error('permanent failure');
      },
      { connection },
    );

    const job = await queue.add('doomed', {}, fastRetries);
    await expect(job.waitUntilFinished(events)).rejects.toThrow(
      'permanent failure',
    );

    const failed = await queue.getJob(job.id!);
    expect(await failed?.getState()).toBe('failed');
    expect(failed?.attemptsMade).toBe(5);
  });
});
