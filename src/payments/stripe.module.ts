import { Global, Module } from '@nestjs/common';
import Stripe from 'stripe';
import { CONFIG, type Env } from '../config.js';

export const STRIPE = Symbol('STRIPE');

@Global()
@Module({
  providers: [
    {
      provide: STRIPE,
      inject: [CONFIG],
      // The SDK retries network errors itself and reuses one idempotency key across those retries.
      useFactory: (config: Env) =>
        new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2 }),
    },
  ],
  exports: [STRIPE],
})
export class StripeModule {}
