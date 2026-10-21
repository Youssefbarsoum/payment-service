import { hashRequest } from './idempotency.js';

describe('hashRequest', () => {
  it('is independent of object key order, at every depth', () => {
    expect(hashRequest({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashRequest({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it('changes when a value changes', () => {
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });

  it('keeps array order significant', () => {
    expect(hashRequest([1, 2])).not.toBe(hashRequest([2, 1]));
  });
});
