import { Module } from '@nestjs/common';
import { RefundsModule } from '../refunds/refunds.module.js';
import { PaymentIntentsService } from './payment-intents.service.js';
import { WebhookHandlerService } from './webhook-handler.service.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [RefundsModule],
  controllers: [WebhooksController],
  providers: [PaymentIntentsService, WebhookHandlerService],
  exports: [PaymentIntentsService],
})
export class PaymentsModule {}
