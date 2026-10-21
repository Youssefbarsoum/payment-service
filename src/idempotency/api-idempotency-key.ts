import { ApiHeader } from '@nestjs/swagger';

/** Swagger docs for the `@IdempotencyKey()` header. */
export const ApiIdempotencyKey = () =>
  ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Unique per logical operation (e.g. a UUID). Retrying with the same key replays the original response instead of repeating the operation.',
  });
