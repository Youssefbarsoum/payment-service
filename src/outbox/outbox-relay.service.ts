import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { asc, inArray, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module.js';
import { outbox } from '../db/schema.js';
import { JOBS_QUEUE, type JobData } from '../queue/jobs.js';
import { backgroundLoopsEnabled, runEvery } from '../run-every.js';
import { EVENT_JOBS, type OutboxEvent } from './outbox.js';

const BATCH_SIZE = 100;
const INTERVAL_MS = 1000;

@Injectable()
export class OutboxRelayService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxRelayService.name);
  private stop?: () => void;

  constructor(
    @Inject(DB) private readonly db: Db,
    @InjectQueue(JOBS_QUEUE) private readonly queue: Queue,
  ) {}

  onApplicationBootstrap() {
    if (backgroundLoopsEnabled()) {
      this.stop = runEvery(INTERVAL_MS, () => this.relayOnce(), this.logger);
    }
  }

  onModuleDestroy() {
    this.stop?.();
  }

  /**
   * Publishes one batch of unpublished outbox rows. Returns how many rows were published.
   *
   * Delivery is at-least-once: a crash after enqueueing but before marking the
   * rows published re-enqueues them on the next run. The deterministic jobId
   * (`<outboxId>-<jobName>`) makes BullMQ drop those duplicates, and every
   * consumer is idempotent anyway.
   */
  async relayOnce(): Promise<number> {
    return this.db.transaction(async (tx) => {
      // SKIP LOCKED: several api instances can relay at once without
      // publishing the same row twice or waiting on each other.
      const rows = await tx
        .select()
        .from(outbox)
        .where(isNull(outbox.publishedAt))
        .orderBy(asc(outbox.id))
        .limit(BATCH_SIZE)
        .for('update', { skipLocked: true });
      if (rows.length === 0) return 0;

      const jobs = rows.flatMap((row) =>
        EVENT_JOBS[row.eventType as OutboxEvent].map((name) => ({
          name,
          data: row.payload as JobData,
          opts: { jobId: `${row.id}-${name}` },
        })),
      );
      // The one network call made inside a transaction, on purpose: it only
      // holds these outbox rows. If Redis is down this throws, nothing is
      // marked published, and the next tick retries.
      if (jobs.length > 0) await this.queue.addBulk(jobs);

      await tx
        .update(outbox)
        .set({ publishedAt: sql`now()` })
        .where(
          inArray(
            outbox.id,
            rows.map((r) => r.id),
          ),
        );
      this.logger.debug({ rows: rows.length, jobs: jobs.length }, 'relayed');
      return rows.length;
    });
  }
}
