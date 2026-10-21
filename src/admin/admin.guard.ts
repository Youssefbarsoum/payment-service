import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { CONFIG, type Env } from '../config.js';

/** Static API key for admin routes. Constant-time comparison avoids leaking the key through timing. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Env) {}

  canActivate(ctx: ExecutionContext): boolean {
    const provided = Buffer.from(
      ctx.switchToHttp().getRequest<Request>().header('x-api-key') ?? '',
    );
    const expected = Buffer.from(this.config.ADMIN_API_KEY);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'A valid x-api-key header is required',
      });
    }
    return true;
  }
}
