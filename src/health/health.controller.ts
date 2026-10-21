import { InjectQueue } from '@nestjs/bullmq';
import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module.js';
import { JOBS_QUEUE } from '../queue/jobs.js';
import { withTimeout } from '../timeout.js';

const up = () => 'up' as const;
const down = () => 'down' as const;

@ApiTags('ops')
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
      withTimeout(this.queue.count(), 2000, 'redis check').then(up, down),
    ]);
    const status = db === 'up' && redis === 'up' ? 'ok' : 'error';
    if (status !== 'ok') {
      throw new ServiceUnavailableException({ status, db, redis });
    }
    return { status, db, redis };
  }
}
