/**
 * Oversell check under load: 500 buyers race for 50 items.
 * Passes only if exactly 50 orders succeed and stock ends at exactly 0.
 *
 *   npm run load-test            (needs the api running, see README)
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const API = process.env.API_URL ?? 'http://localhost:3000';
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5434/payments';
const STOCK = 50;
const BUYERS = 500;
// Capped because thousands of sockets at once mostly measures the OS / Docker
// port proxy. 100 in flight is still heavy contention on one 50-unit row.
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 100);

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const {
  rows: [product],
} = await pool.query<{ id: number }>(
  `insert into products (name, price_cents, stock) values ('Load Test Item', 1000, $1)
   on conflict (name) do update set stock = excluded.stock
   returning id`,
  [STOCK],
);

console.log(
  `${BUYERS} buyers (${CONCURRENCY} in flight at once), ${STOCK} in stock…`,
);
const buy = async (i: number) => {
  const t0 = performance.now();
  const res = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({
      email: `load${i}@example.com`,
      items: [{ productId: product.id, quantity: 1 }],
    }),
  });
  await res.arrayBuffer();
  return { status: res.status, ms: performance.now() - t0 };
};

const started = performance.now();
const results: { status: number; ms: number }[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < BUYERS) results.push(await buy(next++));
  }),
);
const elapsed = performance.now() - started;

const histogram: Record<number, number> = {};
for (const r of results) histogram[r.status] = (histogram[r.status] ?? 0) + 1;
const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p: number) =>
  latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
const {
  rows: [{ stock }],
} = await pool.query<{ stock: number }>(
  'select stock from products where id = $1',
  [product.id],
);
await pool.end();

console.log('status codes:', histogram);
console.log(
  `latency p50 ${pct(0.5).toFixed(0)}ms, p95 ${pct(0.95).toFixed(0)}ms, total ${elapsed.toFixed(0)}ms`,
);
console.log(`final stock: ${stock}`);

const ok = histogram[201] === STOCK && stock === 0;
console.log(ok ? 'PASS: no overselling' : 'FAIL');
process.exit(ok ? 0 : 1);
