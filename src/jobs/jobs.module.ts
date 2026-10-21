import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { RefundsModule } from '../refunds/refunds.module.js';
import { FulfillmentService } from './fulfillment.service.js';
import { JobsProcessor } from './jobs.processor.js';

@Module({
  imports: [QueueModule, EmailModule, RefundsModule],
  providers: [JobsProcessor, FulfillmentService],
})
export class JobsModule {}
