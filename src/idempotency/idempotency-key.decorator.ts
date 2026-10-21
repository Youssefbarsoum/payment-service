import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

/** Reads and validates the `Idempotency-Key` header. Required on every endpoint that uses it. */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const key = ctx
      .switchToHttp()
      .getRequest<Request>()
      .header('idempotency-key');
    if (!key || key.trim() === '') {
      throw new BadRequestException({
        code: 'idempotency_key_required',
        message: 'The Idempotency-Key header is required',
      });
    }
    if (key.length > 255) {
      throw new BadRequestException({
        code: 'idempotency_key_too_long',
        message: 'The Idempotency-Key header must be at most 255 characters',
      });
    }
    return key;
  },
);
