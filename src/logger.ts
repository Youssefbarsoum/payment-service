import type { Params } from 'nestjs-pino';

export function loggerOptions(): Params {
  const env = process.env.NODE_ENV;
  return {
    pinoHttp: {
      level: env === 'test' ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
      transport: env === 'development' ? { target: 'pino-pretty' } : undefined,
      // requestContextMiddleware has already assigned req.id.
      genReqId: (req) => (req as { id?: string }).id ?? 'unknown',
      redact: ['req.headers["stripe-signature"]', 'req.headers["x-api-key"]'],
    },
  };
}
