import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule, {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
// On SIGTERM, in-flight jobs finish before the process exits.
app.enableShutdownHooks();
app.get(Logger).log('worker started');
