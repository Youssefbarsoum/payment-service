import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config.module.js';
import { DbModule } from './db/db.module.js';
import { loggerOptions } from './logger.js';

@Module({
  imports: [ConfigModule, LoggerModule.forRoot(loggerOptions()), DbModule],
})
export class WorkerModule {}
