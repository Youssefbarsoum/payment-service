import { Module } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { CONFIG, type Env } from '../config.js';
import { EmailService, MAIL_TRANSPORT } from './email.service.js';

@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [CONFIG],
      useFactory: (config: Env) =>
        nodemailer.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: false,
        }),
    },
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}
