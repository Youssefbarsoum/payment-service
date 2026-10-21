import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CONFIG, type Env } from '../config.js';
import { JOB_DEFAULTS, JOBS_QUEUE, redisConnection } from './jobs.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: Env) => ({
        connection: redisConnection(config.REDIS_URL),
        defaultJobOptions: JOB_DEFAULTS,
      }),
    }),
    BullModule.registerQueue({ name: JOBS_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
