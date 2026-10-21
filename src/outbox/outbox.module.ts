import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { OutboxRelayService } from './outbox-relay.service.js';

@Module({
  imports: [QueueModule],
  providers: [OutboxRelayService],
})
export class OutboxModule {}
