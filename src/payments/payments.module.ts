import { Module } from '@nestjs/common';
import { PaymentIntentsService } from './payment-intents.service.js';

@Module({
  providers: [PaymentIntentsService],
  exports: [PaymentIntentsService],
})
export class PaymentsModule {}
