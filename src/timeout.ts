/**
 * Rejects if `promise` hasn't settled within `ms`. Used around Redis calls:
 * the BullMQ connection retries forever while Redis is down, so without a
 * deadline a caller would hang (and hold whatever it has locked).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
