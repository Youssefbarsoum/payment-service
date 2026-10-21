import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config.module.js';
import { DbModule } from './db/db.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { loggerOptions } from './logger.js';
import { MaintenanceModule } from './maintenance/maintenance.module.js';
import { StripeModule } from './payments/stripe.module.js';

/** The worker process: BullMQ job processors and background maintenance. */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot(loggerOptions()),
    DbModule,
    StripeModule,
    JobsModule,
    MaintenanceModule,
  ],
})
export class WorkerModule {}
