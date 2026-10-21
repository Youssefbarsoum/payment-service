import type { ConnectionOptions, DefaultJobOptions } from 'bullmq';

export const JOBS_QUEUE = 'jobs';

export type JobName =
  | 'fulfill-order'
  | 'email-order-confirmation'
  | 'email-payment-failed'
  | 'email-refund-confirmation'
  | 'stripe-refund';

export interface JobData {
  orderId: string;
  refundId?: string;
  requestId?: string;
}

/**
 * Every job: 5 attempts with exponential backoff (1s, 2s, 4s, 8s), then it
 * stays in the failed set (our dead-letter queue) for inspection and manual
 * retry. Completed jobs are kept 7 days, so their ids keep deduplicating
 * outbox re-publishes for that window.
 */
export const JOB_DEFAULTS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: false,
};

export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: Number(u.pathname.slice(1) || 0),
    username: u.username || undefined,
    password: u.password || undefined,
    // Required by BullMQ workers: blocking commands must not time out.
    maxRetriesPerRequest: null,
  };
}
