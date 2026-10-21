import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { EmailService } from '../email/email.service.js';
import { JOBS_QUEUE, type JobData, type JobName } from '../queue/jobs.js';
import { FulfillmentService } from './fulfillment.service.js';

@Processor(JOBS_QUEUE, { concurrency: 5 })
export class JobsProcessor extends WorkerHost {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(
    private readonly fulfillment: FulfillmentService,
    private readonly email: EmailService,
  ) {
    super();
  }

  /** Throwing makes BullMQ retry the job with backoff (see JOB_DEFAULTS). */
  async process(job: Job<JobData, unknown, JobName>): Promise<unknown> {
    const { orderId, requestId } = job.data;
    this.logger.log(
      {
        jobId: job.id,
        name: job.name,
        orderId,
        requestId,
        attempt: job.attemptsMade + 1,
      },
      'processing job',
    );

    switch (job.name) {
      case 'fulfill-order':
        return this.fulfillment.fulfill(orderId);
      case 'email-order-confirmation':
        return this.email.sendOnce(job.id!, orderId, 'order_confirmation');
      case 'email-payment-failed':
        return this.email.sendOnce(job.id!, orderId, 'payment_failed');
      case 'email-refund-confirmation':
        return this.email.sendOnce(job.id!, orderId, 'refund_confirmation');
      default:
        throw new Error(`Unknown job: ${job.name}`);
    }
  }
}
