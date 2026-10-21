import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { HealthController } from './health.controller.js';

@Module({ imports: [QueueModule], controllers: [HealthController] })
export class HealthModule {}
