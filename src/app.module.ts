import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { loggerOptions } from './logger.js';
import { requestContextMiddleware } from './request-context.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot(loggerOptions()),
    DbModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(requestContextMiddleware).forRoutes('*path');
  }
}
