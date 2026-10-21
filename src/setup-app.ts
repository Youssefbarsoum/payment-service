import { INestApplication, ValidationPipe } from '@nestjs/common';

/** Shared by main.ts and the test harness, so tests run the same pipeline as production. */
export function setupApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
}
