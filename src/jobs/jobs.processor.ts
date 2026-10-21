import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { EmailService } from '../email/email.service.js';
import { JOBS_QUEUE, type JobData, type JobName } from '../queue/jobs.js';
import { RefundsService } from '../refunds/refunds.service.js';
import { FulfillmentService } from './fulfillment.service.js';

@Processor(JOBS_QUEUE, { concurrency: 5 })
export class JobsProcessor extends WorkerHost {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(
    private readonly fulfillment: FulfillmentService,
    private readonly email: EmailService,
    private readonly refunds: RefundsService,
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
      case 'stripe-refund':
        return this.refunds.submitToStripe(job.data.refundId!);
      default:
        throw new Error(`Unknown job: ${job.name}`);
    }
  }

  /**
   * After the last attempt, a refund job must not leave its order stuck in
   * refund_pending: mark the refund failed and restore the order.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<JobData>): Promise<void> {
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    this.logger.error(
      { jobId: job.id, name: job.name, attempts: job.attemptsMade, exhausted },
      job.failedReason ?? 'job failed',
    );
    if (exhausted && job.name === 'stripe-refund') {
      await this.refunds.applyRefundOutcome(job.data.refundId!, 'failed');
    }
  }
}
