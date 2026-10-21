import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { AdminController } from './admin.controller.js';

@Module({
  imports: [QueueModule],
  controllers: [AdminController],
})
export class AdminModule {}
