import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AdminModule } from './admin/admin.module.js';
import { ConfigModule } from './config.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { loggerOptions } from './logger.js';
import { OrdersModule } from './orders/orders.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { StripeModule } from './payments/stripe.module.js';
import { ProductsModule } from './products/products.module.js';
import { requestContextMiddleware } from './request-context.js';

/** The api process: HTTP endpoints, Stripe webhooks and the outbox relay. */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot(loggerOptions()),
    DbModule,
    StripeModule,
    HealthModule,
    ProductsModule,
    OrdersModule,
    OutboxModule,
    AdminModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(requestContextMiddleware).forRoutes('*path');
  }
}
