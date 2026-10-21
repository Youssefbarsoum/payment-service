import type { LoggerService } from '@nestjs/common';

/**
 * Runs `task` every `ms` milliseconds, never overlapping itself: a tick that
 * starts while the previous run is still going is skipped. Returns a stop function.
 */
export function runEvery(
  ms: number,
  task: () => Promise<unknown>,
  logger: LoggerService,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    task()
      .catch((err: unknown) => logger.error(err))
      .finally(() => (running = false));
  }, ms);
  return () => clearInterval(timer);
}

/** Background loops are off in tests, which drive them by calling the task directly. */
export const backgroundLoopsEnabled = () => process.env.NODE_ENV !== 'test';
