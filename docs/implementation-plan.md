# Order & Payment Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a NestJS order/payment service with Stripe test-mode PaymentIntents, verified + deduplicated webhooks, idempotency keys, a transactional outbox, and a BullMQ worker for fulfillment, emails and refunds. It must stay correct under concurrency and failure.

**Architecture:** One NestJS codebase with two entrypoints: `api` (HTTP, webhooks, outbox relay) and `worker` (BullMQ processor, expiry sweeper, retention pruning). Postgres is the source of truth. Every state change is a compare-and-set inside a transaction that also writes its outbox row. Redis/BullMQ only carries work and is never the only record of anything.

**Tech Stack:** Node 24, NestJS 11, TypeScript (strict), PostgreSQL 17, Drizzle ORM + drizzle-kit + `pg`, BullMQ + `@nestjs/bullmq`, Redis 7, `stripe` SDK, Nodemailer + Mailpit, class-validator/class-transformer, nestjs-pino, `@nestjs/swagger`, Jest + supertest, Docker Compose, GitHub Actions.

**Spec:** `docs/design.md`. Read it first. Section numbers (§) below refer to it.

## Global Constraints

- Money is integer cents; currency `usd` only; full refunds only.
- Order payment window: **15 minutes**. Expiry hard deadline for succeeded/processing PIs: **expires_at + 1h**.
- Job defaults: **5 attempts**, exponential backoff starting at **1000 ms**, `removeOnComplete: { age: 7 days }`, failed jobs kept (`removeOnFail: false`).
- Retention: idempotency_keys, webhook_events, and published outbox rows older than **7 days** are pruned.
- Sweeper interval **30 s**; relay interval **1 s**; pruning interval **1 h**. Interval loops never overlap (an in-flight flag per loop).
- No network calls (Stripe, SMTP) inside a DB transaction. The one exception is the outbox relay enqueueing to Redis while holding SKIP LOCKED outbox rows (§8.4); comment why at that spot.
- Every order status change goes through `casOrderStatus` (Task 2). There are no raw `UPDATE orders SET status`.
- Plain NestJS modules + services. Stateless helpers (`casOrderStatus`, `enqueueOutbox`, `hashRequest`) are plain exported functions taking a `tx`, with no DI and no interface-per-class.
- Tests run against real Postgres (`payments_test` database) and Redis (db 1). Stripe is replaced by `FakeStripe` (Task 4). Integration tests run with `--runInBand`.
- Env vars: `DATABASE_URL`, `REDIS_URL`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM`, `PORT` (default 3000). Startup fails fast if any required one is missing.
- Commit after every task (conventional-commit messages). The git history is part of the portfolio.

## Plan-level calls (deviations / refinements of the spec, made here)

- **Phase order:** refunds (Task 7) come before expiry (Task 8), because expiry's late-payment path calls the refund code.
- **The worker applies the refund result too.** The worker applies the status returned by `refunds.create` immediately, and the `refund.created` / `refund.updated` / `refund.failed` webhooks apply it as well. Both go through the same CAS, so whichever lands first wins. In test mode Stripe refunds often succeed at creation and no `refund.updated` ever fires, so the webhook alone isn't enough.
- **Error responses aren't stored.** If the wrapped work throws (e.g. 409 out of stock), the transaction rolls back, nothing is stored, and a retry with the same key re-executes. Documented in README.
- **Correlation id** is carried with Node's `AsyncLocalStorage` (stdlib), not a library. The order id is also logged on every job.
- **DLQ inspection** uses admin endpoints (`GET /admin/jobs/failed`, `POST /admin/jobs/:id/retry`) instead of a dashboard dependency.
- **Load check** is a plain `fetch` + `Promise.all` script, with no load-testing dependency.
- **Plan location** is `docs/implementation-plan.md` (CV-friendly; spec at `docs/design.md`).

## Review Focus

1. **Malformed order bodies** (bad email, quantity 0 or > 10, empty items, duplicate productId, unknown productId) → 400/404 with a clear message, never 500 and never a partial reservation. Tests in Task 2.
2. **Bad order ids** (non-uuid, unknown uuid) on every `/orders/:id…` route → 400/404, never 500. Tests in Tasks 2, 4, 7.
3. **Missing/oversized `Idempotency-Key`** → 400 before any DB work. Tests in Task 3.
4. **Webhook with missing `stripe-signature` header, wrong secret, or re-serialized body** → 400 and nothing stored. Tests in Task 5.
5. **Stripe API down during PaymentIntent creation** → 502, order unchanged, and a retry after recovery returns one PI (same idempotency key). Tests in Task 4.

---

## File Structure

```
docker-compose.yml            postgres:17, redis:7 (--appendonly yes), mailpit; api+worker added in Task 9
docker/postgres-init.sql      creates database payments_test
Dockerfile                    (Task 9) multi-stage build
drizzle.config.ts
drizzle/                      generated SQL migrations (committed)
src/
  main.ts                     api bootstrap (rawBody: true, pino, swagger, static, shutdown hooks)
  worker.ts                   worker bootstrap (createApplicationContext(WorkerModule))
  app.module.ts               api root module
  worker.module.ts            worker root module
  config.ts                   Env class (class-validator) + loadConfig(); CONFIG token
  request-context.ts          AsyncLocalStorage<{ requestId: string }> + middleware
  db/schema.ts                all Drizzle tables/enums (grows per task)
  db/db.module.ts             global: DB token (NodePgDatabase<typeof schema>), Pool lifecycle; exports Db, Tx types
  db/migrate.ts               runs drizzle migrator (script)
  db/seed.ts                  inserts demo products (idempotent)
  health/health.controller.ts
  products/products.module.ts, products.controller.ts
  orders/orders.module.ts, orders.controller.ts, orders.service.ts, orders.dto.ts
  orders/order-status.ts      OrderStatus type, casOrderStatus()
  idempotency/idempotency.ts  hashRequest(), withIdempotency()
  idempotency/idempotency-key.decorator.ts
  payments/stripe.provider.ts STRIPE token (global module)
  payments/payments.module.ts, payment-intents.service.ts, webhooks.controller.ts, webhook-handler.service.ts
  outbox/outbox.ts            enqueueOutbox(), EVENT_JOBS map
  outbox/outbox-relay.service.ts
  queue/queue.module.ts       BullModule.forRoot + registerQueue('jobs'); JOB_DEFAULTS
  jobs/jobs.module.ts, jobs.processor.ts, fulfillment.service.ts
  email/email.module.ts, email.service.ts   MAIL_TRANSPORT token
  refunds/refunds.module.ts, refunds.controller.ts, refunds.service.ts
  admin/admin.guard.ts, admin.controller.ts (failed jobs)
  maintenance/maintenance.module.ts, maintenance.service.ts
public/index.html             (Task 9) Stripe Elements test page
scripts/load-test.ts          (Task 9)
test/
  setup-env.ts                sets test env vars
  global-setup.ts             runs migrations on payments_test
  helpers.ts                  createTestApp(), resetDb(), seedProduct(), createOrder()
  fake-stripe.ts              (Task 4)
  webhooks.ts                 (Task 5) signedEvent(), piEvent(), refundEvent()
  *.int-spec.ts               integration tests per task
src/**/*.spec.ts              unit tests
.github/workflows/ci.yml
README.md                     (Task 9)
```

---

### Task 1: Scaffold, infrastructure, config, health, test harness, CI

**Files:**
- Create: everything under "scaffold" above: `package.json` (via Nest CLI), `docker-compose.yml`, `docker/postgres-init.sql`, `drizzle.config.ts`, `src/main.ts`, `src/worker.ts`, `src/app.module.ts`, `src/worker.module.ts`, `src/config.ts`, `src/request-context.ts`, `src/db/*`, `src/health/health.controller.ts`, `test/setup-env.ts`, `test/global-setup.ts`, `test/helpers.ts`, `.github/workflows/ci.yml`, `.env.example`, `.gitignore`
- Delete: Nest CLI boilerplate (`app.controller.ts`, `app.service.ts`, their specs, `test/app.e2e-spec.ts`)
- Test: `src/config.spec.ts`, `test/health.int-spec.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): Env`, which throws listing the missing/invalid keys. `CONFIG` injection token → `Env`.
  - `DB` token → `Db = NodePgDatabase<typeof schema>`; `type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]`. Functions that accept `Db | Tx` use `type DbOrTx = Db | Tx`.
  - `requestContext: AsyncLocalStorage<{ requestId: string }>`; `RequestContextMiddleware` sets `requestId` from the `x-request-id` header or `randomUUID()` and echoes it in the response header.
  - `createTestApp(overrides?: { stripe?: unknown; mailTransport?: unknown }): Promise<{ app: INestApplication; db: Db }>`. It builds AppModule with `rawBody: true` and the same global pipes as `main.ts`. `resetDb(db)` truncates all tables `RESTART IDENTITY CASCADE`. `seedProduct(db, { name?, priceCents, stock }): Promise<number>` returns the id.
- Schema in this task: `products(id serial pk, name text not null, price_cents integer not null check > 0, stock integer not null check >= 0)`.

- [ ] **Step 1: Scaffold.** `npx @nestjs/cli new . --package-manager npm --skip-git --strict`, delete boilerplate, add deps: `drizzle-orm pg ioredis nestjs-pino pino-http class-validator class-transformer` and dev `drizzle-kit @types/pg supertest @types/supertest pino-pretty`. In `package.json`, set the jest `testRegex` to `.*\.(spec|int-spec)\.ts$`, `setupFiles: ['<rootDir>/test/setup-env.ts']`, `globalSetup: '<rootDir>/test/global-setup.ts'`, `rootDir: '.'`. Scripts: `test` = `jest --runInBand`, `db:generate`, `db:migrate` (`ts-node src/db/migrate.ts`), `db:seed`, `start:worker`.
- [ ] **Step 2: docker-compose.yml** with postgres:17 (user/pass `postgres`, db `payments`, init script mounting `docker/postgres-init.sql` → `CREATE DATABASE payments_test;`), redis:7 `--appendonly yes`, mailpit (1025/8025). Healthchecks on all three. Run `docker compose up -d` → all healthy.
- [ ] **Step 3: Write failing tests**

```ts
// src/config.spec.ts
it('throws naming every missing required key', () => {
  expect(() => loadConfig({})).toThrow(/STRIPE_SECRET_KEY/);
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
});
it('defaults PORT to 3000', () => {
  expect(loadConfig(validEnv()).PORT).toBe(3000);
});

// test/health.int-spec.ts
it('GET /health → 200 {status:"ok", db:"up", redis:"up"}', async () => { ... });
it('echoes x-request-id', async () => {
  const res = await request(server).get('/health').set('x-request-id', 'abc');
  expect(res.headers['x-request-id']).toBe('abc');
});
```

- [ ] **Step 4: Run** `npm test` → FAIL (modules missing).
- [ ] **Step 5: Implement.**
  - `config.ts`: an `Env` class validated with `plainToInstance` + `validateSync`, with `enableImplicitConversion`.
  - `db.module.ts`: `@Global()`, creates `Pool({ connectionString, max: 20 })`, ends it in `onApplicationShutdown`.
  - `schema.ts` with `products`; `db:generate` produces the first migration.
  - `migrate.ts` uses `drizzle-orm/node-postgres/migrator`.
  - `seed.ts` inserts 3 products (one with stock 1, to demo the race) `ON CONFLICT DO NOTHING`.
  - Health: `SELECT 1` plus a Redis `PING` via an `ioredis` client created from `REDIS_URL` in the health controller (Task 6 switches it to the queue's client). Returns 503 with the failing part `down`.
  - `main.ts`: `NestFactory.create(AppModule, { rawBody: true, bufferLogs: true })`, `useLogger(app.get(Logger))`, `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, `enableShutdownHooks()`.
  - `worker.ts`: `createApplicationContext(WorkerModule)` + shutdown hooks.
  - `test/setup-env.ts`: test env with `DATABASE_URL=postgres://postgres:postgres@localhost:5432/payments_test`, `REDIS_URL=redis://localhost:6379/1`, dummy Stripe keys (`sk_test_dummy`, `whsec_test`), `ADMIN_API_KEY=test-admin-key`.
- [ ] **Step 6: Run** `npm test` → PASS. `npm run lint` and `npm run build` → clean.
- [ ] **Step 7: CI.** `.github/workflows/ci.yml` on push/PR: services postgres:17 (with `POSTGRES_DB: payments_test`) and redis:7. Steps `npm ci`, `npm run lint`, `npm run build`, `npm test`. `global-setup.ts` runs migrations, so CI needs no separate migrate step.
- [ ] **Step 8: Commit** `chore: scaffold NestJS api + worker with Postgres, Redis, Drizzle, health and CI`

---

### Task 2: Products and order creation with atomic stock reservation

**Files:**
- Create: `src/products/*`, `src/orders/orders.module.ts`, `orders.controller.ts`, `orders.service.ts`, `orders.dto.ts`, `order-status.ts`
- Modify: `src/db/schema.ts` (+ migration), `src/app.module.ts`
- Test: `test/orders.int-spec.ts` (casOrderStatus is exercised through every later task's state tests)

**Interfaces:**
- Schema:
  - `order_status` pg enum `pending_payment | paid | fulfilled | refund_pending | refunded | expired`.
  - `orders(id uuid pk default gen_random_uuid(), customer_email text, status order_status default 'pending_payment', total_cents int, currency text default 'usd', stripe_payment_intent_id text unique null, expires_at timestamptz, created_at, updated_at)`, index on `(status, expires_at)`.
  - `order_items(order_id uuid fk, product_id int fk, quantity int check > 0, unit_price_cents int, pk(order_id, product_id))`.
- Produces:
  - `type OrderStatus`.
  - `casOrderStatus(tx: DbOrTx, orderId: string, from: OrderStatus[], to: OrderStatus): Promise<boolean>`: one `UPDATE … WHERE id AND status IN (from)`, also sets `updated_at`. True iff 1 row. Logs at debug level when false.
  - `OrdersService.createInTx(tx: Tx, dto: CreateOrderDto): Promise<OrderView>`. It takes a `tx` so Task 3 can wrap it.
  - `OrdersService.get(id: string): Promise<OrderView>` (404 if missing).
  - `OrderView = { id, status, customerEmail, totalCents, currency, expiresAt: string, items: { productId, quantity, unitPriceCents }[] }`. Task 7 adds `refunds`.
  - `ORDER_TTL_MS = 15 * 60_000`.
- DTO `CreateOrderDto { email: IsEmail; items: OrderItemDto[] (ArrayMinSize 1, ArrayMaxSize 20, ArrayUnique by productId, ValidateNested) }`, `OrderItemDto { productId: IsInt Min 1; quantity: IsInt Min 1 Max 10 }`.
- Routes: `GET /products` → `[{ id, name, priceCents, stock }]`; `POST /orders` → 201 OrderView (Task 3 adds the key); `GET /orders/:id` (`ParseUUIDPipe`).

- [ ] **Step 1: Write failing tests** (`test/orders.int-spec.ts`)

```ts
it('creates an order, snapshots prices, decrements stock', ...)
  // product priceCents 1500 stock 5; order qty 2 → 201, totalCents 3000,
  // status 'pending_payment', expiresAt ≈ now+15min (±5s), stock now 3
it('rejects when stock is insufficient and reserves nothing', ...)
  // products A(stock 5), B(stock 1); order A×2 + B×2 → 409 {code:'out_of_stock'}; A still 5
it('20 concurrent orders for the last item → exactly one wins', ...)
  // stock 1; Promise.all 20 POSTs → statuses: one 201, nineteen 409; stock 0; orders count 1
it('concurrent multi-item orders in opposite item order do not deadlock', ...)
  // A,B stock 50; 20 orders [A,B] and 20 orders [B,A] in parallel → all 201, A=10, B=10
it.each([
  [{ email: 'nope', items: [{ productId: 1, quantity: 1 }] }],
  [{ email: 'a@b.co', items: [] }],
  [{ email: 'a@b.co', items: [{ productId: 1, quantity: 0 }] }],
  [{ email: 'a@b.co', items: [{ productId: 1, quantity: 11 }] }],
  [{ email: 'a@b.co', items: [{ productId: 1, quantity: 1 }, { productId: 1, quantity: 2 }] }],
])('400 on malformed body %#', ...)
it('404 on unknown productId, no stock touched', ...)
it('GET /orders/:id → 400 non-uuid, 404 unknown uuid, 200 existing', ...)
it('GET /products lists stock', ...)
```

- [ ] **Step 2: Run** `npm test -- orders` → FAIL.
- [ ] **Step 3: Implement.** In `createInTx`:
  - Sort items by productId (consistent lock order, §8.1).
  - For each: `UPDATE products SET stock = stock - q WHERE id = $id AND stock >= q RETURNING price_cents`. Zero rows → check whether the product exists (404 `product_not_found`, else 409 `out_of_stock`) and throw. Throwing rolls back the tx.
  - Insert the order with `expires_at = now + ORDER_TTL_MS` and the items with returned prices.
  - The controller wraps it in `db.transaction` for now. Task 3 replaces that.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(orders): create orders with atomic stock reservation`

---

### Task 3: Idempotency keys on POST /orders

**Files:**
- Create: `src/idempotency/idempotency.ts`, `src/idempotency/idempotency-key.decorator.ts`
- Modify: `src/db/schema.ts` (+ migration), `src/orders/orders.controller.ts`
- Test: `src/idempotency/idempotency.spec.ts`, `test/idempotency.int-spec.ts`

**Interfaces:**
- Schema: `idempotency_keys(key text, endpoint text, request_hash text, response_status int, response_body jsonb, created_at timestamptz default now(), pk(key, endpoint))`.
- Produces:
  - `hashRequest(body: unknown): string`: sha256 hex of a canonical JSON with object keys sorted recursively.
  - `withIdempotency<T>(db: Db, opts: { key: string; endpoint: string; body: unknown; status: number }, work: (tx: Tx) => Promise<T>): Promise<{ status: number; body: T; replayed: boolean }>`.
  - `@IdempotencyKey()` param decorator: reads the `Idempotency-Key` header, 400 `idempotency_key_required` if missing/empty, 400 if > 255 chars.
  - `endpoint` strings: `'POST /orders'`, `'POST /orders/:id/refunds'` (Task 7). For the refund endpoint the order id is part of `body` (`{ orderId }`) so the same key on two orders mismatches.
- Algorithm (fixed by §8.1, write exactly this):

```
tx:
  inserted = INSERT INTO idempotency_keys(key, endpoint, request_hash) VALUES (...) ON CONFLICT DO NOTHING RETURNING key
  -- a concurrent duplicate blocks right here until the first tx commits/rolls back
  if !inserted:
     row = SELECT ... WHERE key, endpoint
     if row.request_hash != hash → throw 422 idempotency_key_mismatch
     return { status: row.response_status, body: row.response_body, replayed: true }
  result = await work(tx)
  UPDATE idempotency_keys SET response_status, response_body = result
  return { status, body: result, replayed: false }
```

- Replayed responses set header `Idempotent-Replayed: true`. The controller sets the status via `@Res({ passthrough: true })`.

- [ ] **Step 1: Write failing tests**

```ts
// unit
it('hashRequest is key-order independent', () =>
  expect(hashRequest({ a: 1, b: { c: 2, d: 3 } })).toBe(hashRequest({ b: { d: 3, c: 2 }, a: 1 })));
it('hashRequest differs on value change', ...)

// integration
it('same key twice → one order, identical body, second has Idempotent-Replayed', ...)
it('10 concurrent requests with the same key → 1 order, stock decremented once, all bodies equal', ...)
it('same key, different body → 422 idempotency_key_mismatch', ...)
it('out_of_stock is not stored: same key succeeds after stock is replenished', ...)
it('missing Idempotency-Key → 400 and no order; 256-char key → 400', ...)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the algorithm. `POST /orders` calls `withIdempotency(db, { key, endpoint: 'POST /orders', body: dto, status: 201 }, tx => orders.createInTx(tx, dto))`.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(idempotency): idempotency keys with concurrent-duplicate safety`

---

### Task 4: Stripe client and PaymentIntent endpoint

**Files:**
- Create: `src/payments/stripe.provider.ts`, `src/payments/payments.module.ts`, `src/payments/payment-intents.service.ts`, `test/fake-stripe.ts`
- Modify: `src/orders/orders.controller.ts` (route), `src/app.module.ts`, `test/helpers.ts` (override `STRIPE` with `FakeStripe` by default)
- Test: `test/payment-intents.int-spec.ts`

**Interfaces:**
- Produces:
  - `STRIPE` token → `Stripe` instance: `new Stripe(key, { maxNetworkRetries: 2 })`, global module.
  - `PaymentIntentsService.getOrCreate(orderId: string): Promise<{ paymentIntentId: string; clientSecret: string }>`.
  - Route `POST /orders/:id/payment-intent` (ParseUUIDPipe) → 200.
  - `FakeStripe`, used by every later task:
    - `paymentIntents.create(params, { idempotencyKey })`: the same key returns the same object. ids `pi_fake_<n>`, `client_secret = id + '_secret'`, `status 'requires_payment_method'`.
    - `paymentIntents.retrieve(id)`, `paymentIntents.cancel(id)` (throws `StripeInvalidRequestError`-shaped `{ code: 'payment_intent_unexpected_state' }` when status is `succeeded`/`processing`).
    - `refunds.create(params, { idempotencyKey })`: same key → same refund. ids `re_fake_<n>`, status `refundStatus` (default `'succeeded'`).
    - `setIntentStatus(id, status)`, `failNext(method: 'paymentIntents.create' | 'refunds.create' | 'paymentIntents.retrieve', times = 1)` (throws `StripeConnectionError`-shaped errors), `calls: Record<string, number>`.
    - `webhooks` = `new Stripe('sk_test_dummy').webhooks` (real signing/verification).
- Behaviour (§8.2):
  - 404 if the order is unknown. 409 `order_not_payable` unless `pending_payment` and `expires_at > now`.
  - If the order has a PI: `retrieve` and return its client secret.
  - Else `create({ amount: total_cents, currency: 'usd', automatic_payment_methods: { enabled: true }, metadata: { order_id } }, { idempotencyKey: 'pi-' + orderId })`. Then CAS-save: `UPDATE orders SET stripe_payment_intent_id = $pi WHERE id AND stripe_payment_intent_id IS NULL AND status = 'pending_payment' AND expires_at > now()`. Zero rows → 409 `order_not_payable`.
  - Stripe connection/API errors → 502 `payment_provider_unavailable`.

- [ ] **Step 1: Write failing tests**

```ts
it('creates a PI with amount = order total, currency usd, metadata.order_id', ...)
it('second call returns the same PI, no second create', ...)        // fake.calls['paymentIntents.create'] === 1
it('concurrent calls → same PI id for all', ...)
it('order past expires_at → 409 order_not_payable', ...)            // set expires_at in the past via db
it('order not pending (status paid) → 409', ...)
it('Stripe down → 502, order has no PI; retry after recovery → 200, one PI', ...)  // failNext('paymentIntents.create')
it('400 non-uuid, 404 unknown order', ...)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the behaviour above.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(payments): idempotent PaymentIntent creation`

---

### Task 5: Stripe webhooks — signature, dedupe, payment state machine, outbox writes

**Files:**
- Create: `src/payments/webhooks.controller.ts`, `src/payments/webhook-handler.service.ts`, `src/outbox/outbox.ts`, `test/webhooks.ts`
- Modify: `src/db/schema.ts` (+ migration), `src/payments/payments.module.ts`
- Test: `test/webhooks.int-spec.ts`

**Interfaces:**
- Schema:
  - `webhook_events(stripe_event_id text pk, type text, payload jsonb, received_at timestamptz default now(), processed_at timestamptz)`.
  - `payments(id serial pk, order_id uuid fk, stripe_payment_intent_id text, stripe_event_id text unique, amount_cents int, status text /* succeeded|failed */, created_at)`.
  - `outbox(id bigserial pk, event_type text, aggregate_id text, payload jsonb, created_at timestamptz default now(), published_at timestamptz null)`, partial index `WHERE published_at IS NULL`.
- Produces:
  - `type OutboxEvent = 'order.paid' | 'payment.failed' | 'refund.requested' | 'order.refunded' | 'order.expired'`.
  - `enqueueOutbox(tx: Tx, event: OutboxEvent, aggregateId: string, payload: Record<string, unknown>): Promise<void>`: adds `requestId` from `requestContext` if present.
  - `WebhookHandlerService.handle(event: Stripe.Event): Promise<'processed' | 'duplicate'>`.
  - `test/webhooks.ts`:
    - `piEvent(type, { id, amount, currency?, orderId }, eventId?)` returns a `Stripe.Event`-shaped object.
    - `refundEvent(type, { id, status, refundId }, eventId?)` (used in Task 7).
    - `postWebhook(server, event, secret = 'whsec_test')` serializes once, signs with `generateTestHeaderString`, and posts the raw string with `content-type: application/json`.
- Route `POST /webhooks/stripe`:
  - Uses `req.rawBody` + `stripe-signature` header with `constructEvent` and `STRIPE_WEBHOOK_SECRET`.
  - Missing header/raw body or a bad signature → 400 `invalid_signature`. Otherwise 200 `{ received: true }` (also for duplicates).
  - Handler errors → 500 (Stripe retries).
- Handler (§8.3): one tx: `INSERT webhook_events ON CONFLICT DO NOTHING`. Conflict → return `'duplicate'`. Otherwise switch on the event type:
  - `payment_intent.succeeded`:
    - Insert payment (succeeded).
    - If `amount_received !== total_cents` or the currency differs → `logger.error` with the order id + amounts. Task 7 adds the auto-refund here; leave a `// Task 7` hook comment.
    - Else if `casOrderStatus(tx, id, ['pending_payment'], 'paid')` → `enqueueOutbox('order.paid')`.
    - Else, if the order is `expired`, Task 7 adds the late-payment refund. Any other status → no-op.
  - `payment_intent.payment_failed`: insert payment (failed); if the order is still `pending_payment` → `enqueueOutbox('payment.failed')`.
  - Default: no-op.
  - Set `processed_at = now()`.
  - The order is found by `metadata.order_id`. If it's missing or unknown → log a warning, return processed (never retry forever).

- [ ] **Step 1: Write failing tests**

```ts
it('valid succeeded event → order paid, 1 payment row, 1 order.paid outbox row', ...)
it('same event delivered twice → still 1 payment row, 1 outbox row, both 200', ...)
it('same event delivered 5× concurrently → 1 payment row, 1 outbox row', ...)
it('payment_failed after succeeded (out of order) → order stays paid, no payment.failed outbox', ...)
it('payment_failed on pending order → stays pending_payment, payment.failed outbox row', ...)
it('amount mismatch → not paid, error logged, payment row recorded', ...)
it('missing stripe-signature → 400, nothing in webhook_events', ...)
it('signed with wrong secret → 400', ...)
it('body re-serialized after signing (whitespace changed) → 400', ...)
it('unknown event type → 200, stored, no state change', ...)
it('handler throws mid-transaction → 500 and webhook_events row rolled back (redelivery reprocesses)', ...)
  // e.g. jest.spyOn on enqueueOutbox module to throw once, then redeliver → processed
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the handler spec.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(webhooks): verified, deduplicated Stripe webhooks with outbox events`

---

### Task 6: Outbox relay, BullMQ worker, fulfillment, emails, DLQ admin endpoints

**Files:**
- Create: `src/queue/queue.module.ts`, `src/outbox/outbox-relay.service.ts`, `src/jobs/*`, `src/email/*`, `src/admin/admin.guard.ts`, `src/admin/admin.controller.ts`
- Modify: `src/db/schema.ts` (+ migration), `src/outbox/outbox.ts` (EVENT_JOBS), `src/app.module.ts`, `src/worker.module.ts`, `src/health/health.controller.ts` (ping via the queue's Redis client instead of its own)
- Test: `test/outbox-relay.int-spec.ts`, `test/jobs.int-spec.ts`, `test/queue-retries.int-spec.ts`, `test/admin-jobs.int-spec.ts`

**Interfaces:**
- Schema: `sent_emails(order_id uuid, kind text, sent_at timestamptz default now(), pk(order_id, kind))`.
- Produces:
  - Queue name `'jobs'`. `JOB_DEFAULTS = { attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 7 * 24 * 3600 }, removeOnFail: false }`.
  - `type JobName = 'fulfill-order' | 'email-order-confirmation' | 'email-payment-failed' | 'email-refund-confirmation' | 'stripe-refund'`.
  - Job data: `{ orderId: string; refundId?: string; requestId?: string }`.
  - `EVENT_JOBS: Record<OutboxEvent, JobName[]>`:
    - `order.paid` → `['fulfill-order', 'email-order-confirmation']`
    - `payment.failed` → `['email-payment-failed']`
    - `refund.requested` → `['stripe-refund']`
    - `order.refunded` → `['email-refund-confirmation']`
    - `order.expired` → `[]`
  - `OutboxRelayService.relayOnce(): Promise<number>`, which returns the rows published. It also starts a 1 s interval in `onApplicationBootstrap`, cleared in `onModuleDestroy`. The interval is disabled when `NODE_ENV === 'test'`; tests call `relayOnce`.
  - Relay algorithm: one tx: `SELECT … WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`. Then `queue.addBulk` with `opts.jobId = \`${row.id}-${jobName}\``. Then `UPDATE … SET published_at = now()` for those ids.
  - `JobsProcessor extends WorkerHost` (`@Processor('jobs')`) dispatches on `job.name`. It logs `{ jobId, name, orderId, requestId, attempt }`. `stripe-refund` is added in Task 7: throw `Unknown job` for now.
  - `FulfillmentService.fulfill(orderId)`: `await setTimeout(200)` (simulated work), then `casOrderStatus(['paid'], 'fulfilled')`. A false result is a no-op.
  - `MAIL_TRANSPORT` token → a nodemailer `Transporter` (SMTP to `SMTP_HOST:SMTP_PORT`). Tests override it with `nodemailer.createTransport({ jsonTransport: true })` wrapped in a jest spy.
  - `EmailService.sendOnce(orderId: string, kind: 'order_confirmation' | 'payment_failed' | 'refund_confirmation'): Promise<'sent' | 'skipped'>` loads the order email, skips if a `sent_emails` row exists, sends, then inserts the row `ON CONFLICT DO NOTHING`. Subjects:
    - `Order confirmed — #<first 8 of id>`
    - `Payment failed — #…`
    - `Refund processed — #…`
  - `AdminGuard`: `x-api-key` header compared to `ADMIN_API_KEY` with `crypto.timingSafeEqual` (length-checked). 401 otherwise.
  - Admin routes:
    - `GET /admin/jobs/failed` → `[{ id, name, data, attemptsMade, failedReason, finishedOn }]`
    - `POST /admin/jobs/:id/retry` → 202 (`job.retry()`), 404 unknown.

- [ ] **Step 1: Write failing tests**

```ts
// outbox-relay
it('publishes unpublished rows as jobs named per EVENT_JOBS, marks published_at', ...)
  // order.paid row → waiting jobs 'fulfill-order' + 'email-order-confirmation', jobIds `${id}-…`
it('re-running relay after resetting published_at (simulated crash) does not duplicate jobs', ...)
it('two concurrent relayOnce calls publish each row once', ...)
// jobs (call processor.process with a constructed Job-like object)
it('fulfill-order: paid → fulfilled; second run is a no-op', ...)
it('fulfill-order on refund_pending order → stays refund_pending', ...)
it('email-order-confirmation sends once; second run → skipped, transport called once', ...)
// queue-retries (real BullMQ Worker on a throwaway queue name, JOB_DEFAULTS with backoff delay overridden to 10ms)
it('job failing twice then succeeding → completed with attemptsMade 3', ...)
it('job always failing → ends in failed set after 5 attempts', ...)
// admin-jobs
it('GET /admin/jobs/failed without/with wrong key → 401', ...)
it('lists a failed job and POST retry moves it back to waiting', ...)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the interfaces. Register `QueueModule` in both root modules. `JobsModule` (processor, fulfillment, email) is imported only by `WorkerModule`. `OutboxRelayService` and admin go in `AppModule`. Add the request-context middleware to `AppModule`.
- [ ] **Step 4: Run** `npm test` → PASS. Manual: `npm run start:dev` + `npm run start:worker`, insert an `order.paid` outbox row for a paid order → the email appears in Mailpit (localhost:8025).
- [ ] **Step 5: Commit** `feat(outbox): transactional outbox relay and BullMQ worker for fulfillment and emails`

---

### Task 7: Refunds — admin endpoint, automatic refunds, Stripe refund job, refund webhooks

**Files:**
- Create: `src/refunds/refunds.module.ts`, `refunds.controller.ts`, `refunds.service.ts`
- Modify: `src/db/schema.ts` (+ migration), `src/payments/webhook-handler.service.ts` (mismatch + late payment + refund events), `src/jobs/jobs.processor.ts` (`stripe-refund` + final-failure hook), `src/orders/orders.service.ts` (OrderView `refunds`)
- Test: `test/refunds.int-spec.ts`

**Interfaces:**
- Schema:
  - `refund_status` enum `requested | succeeded | failed`; `refund_reason` enum `admin | late_payment | amount_mismatch`.
  - `refunds(id uuid pk default gen_random_uuid(), order_id uuid fk, stripe_payment_intent_id text not null, amount_cents int, reason refund_reason, status refund_status default 'requested', previous_order_status order_status null, stripe_refund_id text unique null, created_at, updated_at)`.
  - Partial unique index `refunds_one_active_per_order ON refunds(order_id) WHERE status IN ('requested','succeeded')`.
- Produces (`RefundsService`):
  - `requestAdminRefund(tx: Tx, orderId: string): Promise<{ refundId: string; status: 'requested' }>`:
    - `SELECT status, stripe_payment_intent_id, total_cents … FOR UPDATE`. Missing → 404.
    - `casOrderStatus(['paid','fulfilled'], 'refund_pending')`. False → 409 `order_not_refundable`.
    - Insert the refund (`admin`, previous_order_status = the selected status, amount = total_cents). A unique violation → 409 `refund_already_active`.
    - `enqueueOutbox('refund.requested', orderId, { orderId, refundId })`.
  - `requestAutoRefund(tx: Tx, orderId: string, paymentIntentId: string, amountCents: number, reason: 'late_payment' | 'amount_mismatch'): Promise<void>`: insert + outbox. `ON CONFLICT` on the partial index → do nothing (already refunding).
  - `submitToStripe(refundId: string): Promise<void>`:
    - Load the refund. If not `requested` → return.
    - `stripe.refunds.create({ payment_intent, metadata: { refund_id, order_id } }, { idempotencyKey: 'refund-' + refundId })`.
    - Save `stripe_refund_id`, then `applyRefundOutcome(refundId, refund.status)`.
  - `applyRefundOutcome(refundId: string, stripeStatus: string, tx?: Tx): Promise<void>`. It uses `tx` when given (the webhook passes its own), otherwise it opens one:
    - `succeeded`: CAS refund `requested → succeeded`. If it changed and the reason is `admin`: `casOrderStatus(['refund_pending'], 'refunded')` + `enqueueOutbox('order.refunded')`.
    - `failed` | `canceled`: CAS refund `requested → failed`. If it changed and the reason is `admin`: `casOrderStatus(['refund_pending'], previous_order_status)` and `logger.error`.
    - `pending` / other: no-op.
- Route: `POST /orders/:id/refunds` (AdminGuard, ParseUUIDPipe, `@IdempotencyKey()`) → `withIdempotency(db, { key, endpoint: 'POST /orders/:id/refunds', body: { orderId }, status: 202 }, tx => refunds.requestAdminRefund(tx, id))`.
- Webhook additions:
  - Mismatch → `requestAutoRefund(..., pi.amount_received, 'amount_mismatch')`.
  - Succeeded on an `expired` order → `requestAutoRefund(..., 'late_payment')`.
  - `refund.created` / `refund.updated` / `refund.failed` → `metadata.refund_id`. Present and known → `applyRefundOutcome(refundId, refund.status)` (in the webhook tx). Absent/unknown → log a warning, no-op.
- Processor:
  - `stripe-refund` → `submitToStripe(job.data.refundId)`.
  - `@OnWorkerEvent('failed')`: when `job.name === 'stripe-refund' && job.attemptsMade >= job.opts.attempts` → `applyRefundOutcome(refundId, 'failed')`.

- [ ] **Step 1: Write failing tests**

```ts
it('admin refund on paid order → 202 {status:"requested"}, order refund_pending, refund row, refund.requested outbox', ...)
it('no x-api-key → 401; non-uuid → 400; unknown → 404; pending_payment order → 409 order_not_refundable', ...)
it('same Idempotency-Key replays; 5 concurrent refund requests with different keys → one refund row, others 409', ...)
it('submitToStripe → refunds.create once with idempotencyKey refund-<id>; succeeded → order refunded + order.refunded outbox', ...)
it('submitToStripe twice → one Stripe refund, one order.refunded outbox row', ...)
it('refund.updated webhook arriving before submitToStripe saved stripe_refund_id still matches via metadata', ...)
it('refund failed (webhook status failed) → refund failed, order back to fulfilled when it was fulfilled; new admin refund allowed', ...)
it('stripe-refund job exhausting attempts → refund failed, order back to paid', ...)
  // invoke the failed-event handler with attemptsMade 5
it('amount mismatch succeeded event → amount_mismatch refund requested, order stays pending_payment', ...)
it('succeeded event on expired order → late_payment refund requested, order stays expired', ...)
it('the same late-payment event redelivered → still one refund', ...)
it('refund event with no refund_id metadata → 200, no change', ...)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(refunds): admin and automatic refunds via outbox-driven Stripe job`

---

### Task 8: Expiry sweeper and retention pruning (worker)

**Files:**
- Create: `src/maintenance/maintenance.module.ts`, `src/maintenance/maintenance.service.ts`
- Modify: `src/worker.module.ts`
- Test: `test/maintenance.int-spec.ts`

**Interfaces:**
- Produces:
  - `MaintenanceService.sweepExpiredOrders(now = new Date()): Promise<{ expired: number; skipped: number }>`.
  - `MaintenanceService.pruneOldRecords(now = new Date()): Promise<void>`.
  - Intervals: 30 s and 1 h, each with an in-flight guard, off when `NODE_ENV === 'test'`.
- `HARD_EXPIRY_GRACE_MS = 60 * 60_000`.
- Sweep algorithm (§8.5.1). For each `pending_payment` order with `expires_at < now` (limit 100, oldest first):
  - If it has a PI: `retrieve`. Status `succeeded` | `processing` and `now < expires_at + HARD_EXPIRY_GRACE_MS` → skipped++ and continue. Status `requires_*` → `cancel` (ignore `payment_intent_unexpected_state`). A Stripe error → log and continue (the next tick retries).
  - Then one tx: `casOrderStatus(['pending_payment'], 'expired')`. If true: `UPDATE products SET stock = stock + oi.quantity FROM order_items oi WHERE oi.order_id = $id AND products.id = oi.product_id` and `enqueueOutbox('order.expired')`.
- Prune: delete `idempotency_keys` and `webhook_events` with `created_at`/`received_at` < now − 7d, and outbox rows with `published_at` < now − 7d.

- [ ] **Step 1: Write failing tests**

```ts
it('expires an overdue unpaid order without PI and restores stock', ...)
it('cancels a requires_payment_method PI, then expires', ...)          // fake PI status canceled
it('does not expire an order whose PI is processing before the hard deadline', ...)
it('expires it after the hard deadline (now = expires_at + 61min)', ...)
it('not-yet-due orders untouched', ...)
it('two concurrent sweeps → stock restored exactly once', ...)
it('Stripe retrieve failure → order left pending, no throw', ...)     // failNext('paymentIntents.retrieve')
it('end-to-end race: sweep expires, then succeeded webhook → late_payment refund', ...)
it('prune removes 8-day-old keys/events/published outbox rows, keeps unpublished and recent', ...)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the algorithm.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(expiry): Postgres-driven order expiry sweeper and retention pruning`

---

### Task 9: Production polish — Docker, Swagger, logging, test page, load check, README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `public/index.html`, `scripts/load-test.ts`, `README.md`
- Modify: `docker-compose.yml` (api + worker services), `src/main.ts` (Swagger, static, pino config), DTOs/controllers (`@ApiProperty`/`@ApiHeader`/`@ApiResponse`), `src/app.module.ts` (`GET /checkout-config`)
- Test: `test/smoke.int-spec.ts`

**Interfaces:**
- `GET /checkout-config` → `{ publishableKey }`.
- `/docs` serves Swagger. The `Idempotency-Key` and `x-api-key` headers are documented on their routes.
- Pino:
  - JSON in production, pino-pretty when `NODE_ENV=development`.
  - `genReqId` uses the request-context id.
  - `stripe-signature` and `x-api-key` are redacted.
- Dockerfile: multi-stage (`node:24-alpine`). `npm ci` → build → prod deps only. Runs as user `node`.
- Compose:
  - `api`: `node dist/db/migrate.js && node dist/db/seed.js && node dist/main.js`, port 3000.
  - `worker`: `node dist/worker.js`, depends on postgres/redis healthy.
  - Both use `env_file: .env`.
- `public/index.html`: a vanilla page loading Stripe.js from `js.stripe.com`. Lists products → creates an order (with a random Idempotency-Key, reused on retry) → creates the PI → Payment Element → confirm → polls `GET /orders/:id` until it leaves `pending_payment`. Shows the status.
- `scripts/load-test.ts` (`npm run load-test`, needs a running stack):
  - Sets one product's stock to 50 via `DATABASE_URL`.
  - Fires 500 concurrent `POST /orders` (qty 1, unique keys) using `fetch`.
  - Prints the status histogram and p50/p95 latency.
  - Exits non-zero unless exactly 50 are 201 and the final stock is 0.

- [ ] **Step 1: Write failing test** (`test/smoke.int-spec.ts`)

```ts
it('GET /docs-json documents POST /orders with Idempotency-Key header', ...)
it('GET /checkout-config returns the publishable key', ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** Swagger + `checkout-config`. **Step 4: Run** → PASS.
- [ ] **Step 5: Docker check.** `docker compose up --build -d` → `curl localhost:3000/health` returns ok, and `npm run load-test` exits 0.
- [ ] **Step 6: Manual Stripe check** (documented in the README):
  - `stripe listen --forward-to localhost:3000/webhooks/stripe` → put the `whsec_…` in `.env`.
  - Pay on `localhost:3000` with `4242 4242 4242 4242` → the order goes paid → fulfilled, and the confirmation email shows in Mailpit.
  - `4000 0000 0000 0002` → payment-failed email.
  - Admin refund via curl → refunded + email.
- [ ] **Step 7: README.md** sections:
  1. One-paragraph pitch.
  2. Architecture diagram (Mermaid flowchart).
  3. Mermaid sequence diagrams: create order + idempotency; pay + webhook; outbox → worker; refund; expiry vs late payment.
  4. The order state machine (Mermaid stateDiagram).
  5. **"What happens if…" failure table** (copy §9 of the design, updated with plan-level calls).
  6. Guarantees & trade-offs: at-least-once email, error responses not stored, jobId dedupe window, why BullMQ over RabbitMQ/Kafka (the swappable relay line).
  7. Run locally (compose, Stripe CLI, test cards, Mailpit, Swagger).
  8. Running tests.
  9. Project structure.
  10. "What I'd add for production": metrics/tracing, partial refunds, the outbox via logical replication/CDC, auth, multi-currency.
  - CI badge at the top.
- [ ] **Step 8: Run** `npm run lint && npm run build && npm test` → all green.
- [ ] **Step 9: Commit** `docs: README with architecture, sequence diagrams and failure-mode table; Docker and load test`
