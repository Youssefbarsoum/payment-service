import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import Stripe from 'stripe';
import { CONFIG, type Env } from '../config.js';
import { STRIPE } from './stripe.module.js';
import { WebhookHandlerService } from './webhook-handler.service.js';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    @Inject(STRIPE) private readonly stripe: Stripe,
    @Inject(CONFIG) private readonly config: Env,
    private readonly handler: WebhookHandlerService,
  ) {}

  @Post('stripe')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    let event: Stripe.Event;
    try {
      // The signature covers the exact bytes sent, so verify the raw body, not parsed JSON.
      event = this.stripe.webhooks.constructEvent(
        req.rawBody ?? '',
        signature ?? '',
        this.config.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      throw new BadRequestException({
        code: 'invalid_signature',
        message: 'Webhook signature verification failed',
      });
    }
    // Errors propagate as 500, so Stripe redelivers the event.
    await this.handler.handle(event);
    return { received: true };
  }
}
