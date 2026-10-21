import {
  Controller,
  Get,
  Inject,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { CONFIG, Env } from '../config.js';
import { DB, type Db } from '../db/db.module.js';

const up = () => 'up' as const;
const down = () => 'down' as const;

@Controller('health')
export class HealthController implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) config: Env,
  ) {
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  }

  @Get()
  async check() {
    const [db, redis] = await Promise.all([
      this.db.execute(sql`select 1`).then(up, down),
      this.redis.ping().then(up, down),
    ]);
    const status = db === 'up' && redis === 'up' ? 'ok' : 'error';
    if (status !== 'ok') {
      throw new ServiceUnavailableException({ status, db, redis });
    }
    return { status, db, redis };
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
