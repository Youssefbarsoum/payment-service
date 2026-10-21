import { InjectQueue } from '@nestjs/bullmq';
import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module.js';
import { JOBS_QUEUE } from '../queue/jobs.js';

const up = () => 'up' as const;
const down = () => 'down' as const;

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @InjectQueue(JOBS_QUEUE) private readonly queue: Queue,
  ) {}

  @Get()
  async check() {
    const [db, redis] = await Promise.all([
      this.db.execute(sql`select 1`).then(up, down),
      // A cheap queue command proves the Redis round-trip the jobs depend on.
      this.queue.count().then(up, down),
    ]);
    const status = db === 'up' && redis === 'up' ? 'ok' : 'error';
    if (status !== 'ok') {
      throw new ServiceUnavailableException({ status, db, redis });
    }
    return { status, db, redis };
  }
}
