import { Module } from '@nestjs/common';
import { RefundsModule } from '../refunds/refunds.module.js';
import { PaymentIntentsService } from './payment-intents.service.js';
import { WebhookHandlerService } from './webhook-handler.service.js';
import { CheckoutConfigController } from './checkout-config.controller.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [RefundsModule],
  controllers: [WebhooksController, CheckoutConfigController],
  providers: [PaymentIntentsService, WebhookHandlerService],
  exports: [PaymentIntentsService],
})
export class PaymentsModule {}
