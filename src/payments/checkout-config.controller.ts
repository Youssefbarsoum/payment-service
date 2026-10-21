import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CONFIG, type Env } from '../config.js';

/** The publishable key is public by design; the test checkout page needs it to load Stripe.js. */
@ApiTags('orders')
@Controller('checkout-config')
export class CheckoutConfigController {
  constructor(@Inject(CONFIG) private readonly config: Env) {}

  @Get()
  get() {
    return { publishableKey: this.config.STRIPE_PUBLISHABLE_KEY };
  }
}
