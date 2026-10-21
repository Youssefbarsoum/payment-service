import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Carries the request id through async calls so it can be stamped on outbox events and logs. */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers['x-request-id'];
  const requestId =
    typeof header === 'string' && header.length > 0 && header.length <= 128
      ? header
      : randomUUID();
  (req as Request & { id: string }).id = requestId;
  res.setHeader('x-request-id', requestId);
  requestContext.run({ requestId }, next);
}
