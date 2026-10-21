import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { join } from 'node:path';

/** Shared by main.ts and the test harness, so tests run the same pipeline as production. */
export function setupApp(app: NestExpressApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  // Test checkout page (public/index.html) at /
  app.useStaticAssets(join(process.cwd(), 'public'));

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Order & Payment Service')
      .setDescription(
        'Orders with stock reservation, Stripe PaymentIntents, idempotency keys, webhooks and refunds.',
      )
      .setVersion('1.0')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'admin')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
}
