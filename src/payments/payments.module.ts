import { Module } from '@nestjs/common';
import { PaymentIntentsService } from './payment-intents.service.js';
import { WebhookHandlerService } from './webhook-handler.service.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  controllers: [WebhooksController],
  providers: [PaymentIntentsService, WebhookHandlerService],
  exports: [PaymentIntentsService],
})
export class PaymentsModule {}
