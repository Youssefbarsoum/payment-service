import { UnprocessableEntityException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import type { Db, Tx } from '../db/db.module.js';
import { idempotencyKeys } from '../db/schema.js';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/** SHA-256 of the body as canonical JSON (object keys sorted at every depth). */
export function hashRequest(body: unknown): string {
  const canonical = JSON.stringify(body, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : value,
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Runs `work` at most once per (key, endpoint).
 *
 * The key row is inserted in the same transaction as the work and its stored
 * response. A concurrent duplicate blocks on the primary-key index until the
 * first transaction finishes:
 * - if it committed, the duplicate sees the stored response and replays it;
 * - if it rolled back (e.g. out of stock), the duplicate's insert succeeds and
 *   it runs the work itself.
 * So there is no "in progress" state that can get stuck after a crash. Failed
 * requests are not stored and may be retried with the same key.
 */
export async function withIdempotency<T>(
  db: Db,
  opts: { key: string; endpoint: string; body: unknown; status: number },
  work: (tx: Tx) => Promise<T>,
): Promise<IdempotentResult<T>> {
  const requestHash = hashRequest(opts.body);
  const match = and(
    eq(idempotencyKeys.key, opts.key),
    eq(idempotencyKeys.endpoint, opts.endpoint),
  );

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(idempotencyKeys)
      .values({ key: opts.key, endpoint: opts.endpoint, requestHash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (inserted.length === 0) {
      const [stored] = await tx.select().from(idempotencyKeys).where(match);
      if (stored.requestHash !== requestHash) {
        throw new UnprocessableEntityException({
          code: 'idempotency_key_mismatch',
          message:
            'This Idempotency-Key was already used with a different request body',
        });
      }
      return {
        status: stored.responseStatus!,
        body: stored.responseBody as T,
        replayed: true,
      };
    }

    const body = await work(tx);
    await tx
      .update(idempotencyKeys)
      .set({ responseStatus: opts.status, responseBody: body })
      .where(match);
    return { status: opts.status, body, replayed: false };
  });
}

/** Applies an idempotent result to the HTTP response (for `@Res({ passthrough: true })`). */
export function sendIdempotent<T>(
  res: Response,
  result: IdempotentResult<T>,
): T {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return result.body;
}
