import { Inject, Injectable } from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import { DB, type Db } from '../db/db.module.js';
import { casOrderStatus } from '../orders/order-status.js';

@Injectable()
export class FulfillmentService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Simulated warehouse call, then paid → fulfilled. Refunded-before-fulfilment orders stay put. */
  async fulfill(orderId: string): Promise<void> {
    await setTimeout(200);
    await casOrderStatus(this.db, orderId, ['paid'], 'fulfilled');
  }
}
