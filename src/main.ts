import './load-env.js';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { setupApp } from './setup-app.js';

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  // Webhook signature verification needs the exact bytes Stripe sent.
  rawBody: true,
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
setupApp(app);
await app.listen(process.env.PORT ?? 3000);
