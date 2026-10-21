# Order & Payment Service — Design

Status: draft · 2026-10-21

## 1. Intent

A backend service that takes orders for limited-stock products, charges them through Stripe (test mode), and fulfills them asynchronously. It exists as a **learning project and CV portfolio piece**. The author must be able to walk an interviewer through the whole payment flow and explain how every failure is handled.

The point isn't features. The point is **correctness under failure and concurrency**: no double charges, no overselling, no lost paid orders, no silently dropped emails or fulfillment.

## 2. Goals

1. Order creation with **atomic stock reservation**. Two buyers racing for the last item → exactly one wins.
2. **Idempotency keys** on mutating client endpoints. Retries and double-clicks never create duplicates.
3. **Stripe PaymentIntents** with **verified, deduplicated webhooks** that are safe when Stripe delivers late, out of order, or more than once.
4. **Transactional outbox**. Every state change that triggers side effects writes its event in the same DB transaction.
5. A **queue worker** (BullMQ) for fulfillment, emails, Stripe refunds, and order expiry, with retries, exponential backoff, and a retained failed-jobs list (DLQ).
6. **Unpaid orders expire** after 15 minutes and release their stock.
7. **Full refunds**, admin-triggered, plus automatic refunds for payments that land on an expired order.
8. **Tests that simulate the failures**: concurrent purchases, concurrent duplicate keys, duplicate and out-of-order webhooks, worker failures. They run against real Postgres and Redis.
9. **One-command local run** (`docker compose up`), CI on every push, and a README with sequence diagrams and a "what happens if…" failure table.
10. Built **in phases, one working, tested commit each**, so the git history reads as a story.

## 3. Non-goals

- User accounts or customer login. The customer is identified by email on the order.
- Real shipping or fulfillment providers. Fulfillment is simulated.
- Multi-currency (USD only), partial refunds, subscriptions, coupons, tax.
- Production deployment (k8s, secrets manager, multi-region).
- A real storefront. Only a tiny test page to pay with a test card.

## 4. Anti-goals (failure even if it "works")

- Any path that can charge twice, oversell stock, or leave a paid order un-fulfilled with no record of why.
- Side effects (email, Stripe calls) done inside a DB transaction or inside the webhook request.
- Architecture ceremony the author can't explain: no interface-per-class, no DDD/hexagonal layering for its own sake. Plain NestJS modules and services, with transactions visible in the code.

## 5. Stack (decided)

| Concern | Choice | Notes |
|---|---|---|
| Framework | **NestJS + TypeScript** (Node 24) | user's choice |
| Database | **PostgreSQL 17** | transactions, row locks, constraints |
| DB access | **Drizzle ORM** + drizzle-kit migrations | user's choice (over Prisma) |
| Queue | **BullMQ + Redis** via `@nestjs/bullmq` | chosen over RabbitMQ/Kafka: single-service task queue needing retries/delays. The outbox publisher stays one small class so the broker is swappable. |
| Payments | **Stripe** test mode, PaymentIntents API, Stripe CLI for local webhooks | |
| Email | Nodemailer → **Mailpit** (Docker) | inbox visible at localhost:8025 |
| Tests | **Jest**, integration tests against real Postgres + Redis | Stripe faked at the SDK boundary in tests |
| Run | **Docker Compose** | api, worker, postgres, redis, mailpit |
| CI | **GitHub Actions** | lint, typecheck, tests with service containers |

## 6. Architecture

One NestJS codebase, **two processes**:

- **api** (`src/main.ts`): HTTP endpoints, the Stripe webhook receiver, and the outbox relay.
- **worker** (`src/worker.ts`): BullMQ processors.

Both can be scaled to N instances safely (see §9).

```
client ──HTTP──▶ api ──txn──▶ Postgres (orders, stock, outbox, idempotency, webhook_events)
Stripe ─webhook─▶ api                    │
                                         ▼ relay (poll, SKIP LOCKED)
                                       Redis/BullMQ ──▶ worker ──▶ Stripe API / SMTP
```

Modules: `products`, `orders`, `payments` (Stripe client + webhooks), `refunds`, `idempotency`, `outbox`, `jobs` (processors), `email`, `db`, `health`.

## 7. Data model

All money is integer cents. All timestamps are `timestamptz`.

- **products**: id, name, price_cents, stock (`CHECK stock >= 0`)
- **orders**: id (uuid), customer_email, status, total_cents, currency, stripe_payment_intent_id (unique, nullable), expires_at, created_at, updated_at
- **order_items**: order_id, product_id, quantity, unit_price_cents (price snapshot)
- **payments**: id, order_id, stripe_payment_intent_id, stripe_event_id, amount_cents, status, created_at. One row per Stripe outcome (succeeded/failed) for audit.
- **refunds**: id (uuid, also the Stripe idempotency key), order_id, amount_cents, reason (`admin` | `late_payment` | `amount_mismatch`), status (`requested` | `succeeded` | `failed`), previous_order_status (nullable, admin refunds only), stripe_refund_id (unique, nullable). **Partial unique index**: at most one refund per order with status in (`requested`, `succeeded`), so a failed refund can be retried but money can never go back twice.
- **idempotency_keys**: PK (key, endpoint), request_hash, response_status, response_body, created_at
- **webhook_events**: stripe_event_id (PK), type, payload, received_at, processed_at
- **outbox**: id (bigserial), event_type, aggregate_id, payload (jsonb), created_at, published_at (nullable)
- **sent_emails**: unique (order_id, kind). Guards against duplicate emails.

### Order state machine

```
pending_payment ──payment succeeded──▶ paid ──fulfill job──▶ fulfilled
       │                                 │                      │
       ├──15 min, unpaid──▶ expired      └──refund requested──▶ refund_pending ──▶ refunded
       └──(payment failed: stays pending; customer may retry another card)
```

Admin refunds are allowed from `paid` or `fulfilled`. A failed refund returns the order to its `previous_order_status`, and the admin may retry.

**The order status describes the order; the refund row describes the money.** The refund job and the refund webhooks are driven by the refund row's status, never by the order's. Automatic refunds (`late_payment`, `amount_mismatch`) never touch the order status: the order stays `expired` or `pending_payment`, and the refund row is the record that the money went back.

**Every transition is a compare-and-set:** `UPDATE orders SET status=$new WHERE id=$id AND status=$expected`. Zero rows updated → the transition lost a race or is stale → no-op, logged. This one rule handles webhook/expiry races and out-of-order events.

## 8. Flows

### 8.1 Create order: `POST /orders` (requires `Idempotency-Key` header)

One DB transaction:

1. `INSERT INTO idempotency_keys … ON CONFLICT DO NOTHING`. A concurrent duplicate **blocks on the unique index** until the first transaction commits or rolls back. That is the race protection, with no "in progress" state that can get stuck.
   - Conflict and same request hash → return the stored response.
   - Conflict and different hash → `422`.
2. For each item, **sorted by product_id** (consistent lock order prevents deadlocks): `UPDATE products SET stock = stock - $q WHERE id=$id AND stock >= $q`. Zero rows → roll back → `409 out_of_stock`.
3. Insert the order (`pending_payment`, expires_at = now + 15 min) and its items with snapshotted prices.
4. Insert outbox `order.created`.
5. Store the response on the idempotency row. Commit. Return `201`.

### 8.2 Start payment: `POST /orders/:id/payment-intent`

Naturally idempotent, so no client key is needed.

- If the order already has a PaymentIntent, return its client_secret.
- Otherwise call Stripe `paymentIntents.create` with **Stripe idempotency key `pi-<orderId>`**, amount = order total, and `metadata.order_id`. Save the PI id with a compare-and-set on `stripe_payment_intent_id IS NULL AND status = 'pending_payment' AND expires_at > now()`. If the CAS fails because the order just expired, return `409` without the client_secret.
- A crash between the Stripe call and the DB save is harmless: the retry gets the same PI back from Stripe.
- Rejected (`409`) unless the order is `pending_payment` and not past expires_at.

This shows **two layers of idempotency**: client→us (our keys) and us→Stripe (Stripe's keys).

### 8.3 Stripe webhook: `POST /webhooks/stripe`

- Raw body + `stripe.webhooks.constructEvent` signature check. Invalid → `400`.
- One DB transaction: `INSERT webhook_events … ON CONFLICT DO NOTHING`. Duplicate → return `200` immediately. Otherwise handle the event in the same transaction, so a failure rolls back the dedupe row and Stripe's retry reprocesses it.
- Only DB work happens here. Side effects go through the outbox, so the handler responds fast.

| Event | Handling |
|---|---|
| `payment_intent.succeeded` | Insert payment row. Amount or currency mismatch → log at error level, insert refund (`amount_mismatch`) + outbox `refund.requested`, don't mark paid. Otherwise CAS `pending_payment → paid` → outbox `order.paid`. If the order is `expired`: insert refund (`late_payment`) + outbox `refund.requested`. If already `paid`/later: no-op. |
| `payment_intent.payment_failed` | Insert payment row (failed). The order stays `pending_payment`. Outbox `payment.failed` (email). |
| `refund.updated` / `refund.failed` | Match by `metadata.refund_id` (always set, because the refund row exists before the Stripe call, so this works even if the event beats the stripe_refund_id save). CAS refund `requested → succeeded/failed`. Admin refund success: CAS order `refund_pending → refunded` + outbox `order.refunded`. Admin refund failure: CAS order `refund_pending → previous_order_status`, log at error level. A refund with no matching row (e.g. made in the Stripe dashboard) is logged and acknowledged. |

Unknown event types are stored and ignored. `charge.refunded` is not used.

### 8.4 Outbox relay (in the api process)

Every ~1s: `SELECT … FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`. For each row, enqueue the BullMQ job(s) with **`jobId = outbox-<id>-<job>`** (BullMQ dedupes by jobId), then set published_at.

- At-least-once: a crash after enqueue but before marking re-enqueues, which jobId dedupe absorbs while the completed job is retained (completed jobs are kept 7 days). Beyond that window, consumer idempotency is the real guarantee, and the README says so.
- Multiple api instances are safe thanks to SKIP LOCKED.
- Redis runs with AOF persistence so queued jobs survive a Redis restart.

| Outbox event | Jobs |
|---|---|
| `order.paid` | `fulfill-order`, `email:order-confirmation` |
| `payment.failed` | `email:payment-failed` |
| `refund.requested` | `stripe-refund` |
| `order.refunded` | `email:refund-confirmation` |

### 8.5 Worker jobs

All jobs: 5 attempts, exponential backoff. Failed jobs are retained (DLQ) and inspectable.

- **fulfill-order**: simulated work, then CAS `paid → fulfilled`. Idempotent via the CAS.
- **email:\***: skip if a `sent_emails` row exists. Otherwise send, then insert the row. Email is **at-least-once**: a crash between send and insert can duplicate one email, and that's documented as accepted.
- **stripe-refund**: if the refund row isn't `requested`, no-op. Call `refunds.create` with **Stripe idempotency key = refund id** and `metadata.refund_id`. Save stripe_refund_id. The final state comes from the webhook. If the job exhausts its attempts, the worker's final-failure handler applies the same "refund failed" transition as the webhook, so the order never sits in `refund_pending` for good.

### 8.5.1 Order expiry sweeper (worker process, every 30s)

Expiry is driven by **Postgres, not Redis**, so it survives Redis data loss. There's no delayed job per order.

- Select `pending_payment` orders with `expires_at < now()` (limit 100).
- For each one with a PI: call Stripe cancel. Already canceled is fine.
- If Stripe says the PI **succeeded or is processing**, and `now < expires_at + 1h`: skip it. The webhook will mark it paid, and the next tick rechecks.
- Otherwise, in one transaction: CAS `pending_payment → expired`, restore stock, outbox `order.expired` (no jobs, audit only).
- Past the 1h hard deadline the order is expired regardless. A payment that still lands is refunded automatically (§8.3). A mismatched payment was already refunded, so the order expires normally.
- Several workers running the sweeper at once is safe: cancel is idempotent, and the CAS lets only one of them win.

### 8.6 Refund: `POST /orders/:id/refunds` (admin API key + `Idempotency-Key`)

One transaction: idempotency row, CAS `paid|fulfilled → refund_pending`, insert refund (`admin`), outbox `refund.requested`, store response. Returns **`202 Accepted`**. The Stripe call happens in the worker, so a Stripe outage only delays the refund and never loses it.

### 8.7 Read endpoints

`GET /products`, `GET /orders/:id`.

## 9. Concurrency & failure summary (seeds the README table)

| What happens if… | Why it's safe |
|---|---|
| Two buyers take the last item | Conditional decrement + `CHECK stock >= 0` |
| User double-clicks "Pay" / client retries | Idempotency key, duplicate blocks on unique index, gets replayed response |
| Same key, different body | 422 |
| Webhook delivered twice | `webhook_events` PK dedupe in the same transaction |
| Webhooks out of order | Compare-and-set state transitions ignore stale events |
| Forged webhook | Signature verification |
| Crash after commit, before enqueue | Outbox row still unpublished, relay picks it up |
| Crash after enqueue, before marking published | jobId dedupe + idempotent consumers |
| Email/Stripe down | Job retries with backoff, then DLQ |
| Crash between Stripe call and DB save | Stripe idempotency keys return the same object |
| Payment succeeds as order expires | Expiry cancels the PI first and waits for succeeded/processing PIs (up to 1h); a payment that lands after expiry is auto-refunded |
| Payment amount doesn't match the order | Not marked paid, auto-refunded |
| Refund fails at Stripe | Refund row `failed`, order back to its previous status, admin can retry; partial unique index prevents a double refund |
| Redis loses data | Expiry is swept from Postgres; unpublished outbox rows are re-enqueued; Redis uses AOF |
| Two workers / two api instances | BullMQ single-consumer per job, SKIP LOCKED relay, CAS updates |
| Deploy / shutdown mid-job | Graceful shutdown; unfinished jobs are retried |

## 10. Operational

- Env config validated at startup. Fail fast on missing Stripe keys.
- Structured JSON logs (pino) with a request/correlation id carried into outbox payloads and job data.
- `GET /health` checks Postgres and Redis.
- Graceful shutdown in both processes.
- OpenAPI docs via `@nestjs/swagger` at `/docs`.
- Idempotency keys and webhook_events are pruned after 7 days (repeatable job).

## 11. Testing

- **Unit**: state-transition rules, request hashing.
- **Integration** (real Postgres + Redis, Stripe faked at the SDK boundary, webhooks signed with `stripe.webhooks.generateTestHeaderString`):
  - 20 parallel orders for stock = 1 → exactly 1 `201`, 19 `409`, stock 0.
  - 10 parallel requests with the same key → 1 order, identical responses.
  - Same key, different body → 422.
  - Duplicate webhook → one payment row, one `order.paid` outbox row.
  - `payment_failed` after `succeeded` → order stays paid.
  - Payment succeeded on an expired order → refund requested, order stays expired.
  - Sweeper with PI `processing` → skipped before the deadline, expired after it.
  - Refund failure (webhook or exhausted job) → order back to paid; a second refund is allowed; two concurrent refund requests → one refund row.
  - Relay runs twice over the same rows → jobs enqueued once.
  - A job that fails twice then succeeds → completed. One that always fails → ends in the failed set.
  - Bad signature → 400. Amount mismatch → not marked paid.
- **Load check**: a script (k6 or autocannon, builder's call) firing a few hundred concurrent orders at limited stock and asserting zero oversell.
- **Manual end-to-end**: Stripe CLI `stripe listen --forward-to` + the test page, paying with `4242…` and a declining card.

## 12. Delivery phases (one commit or small PR each, tests green)

1. Scaffold: Nest app + worker entrypoint, Docker Compose, Drizzle schema/migrations, config validation, health, CI.
2. Products + order creation with stock reservation, plus the race test.
3. Idempotency keys.
4. PaymentIntent endpoint (Stripe idempotency).
5. Webhooks: signature, dedupe, state machine.
6. Outbox + relay + worker: fulfillment and emails (Mailpit).
7. Order expiry (Postgres sweeper, PI cancel, late-payment auto-refund).
8. Refunds (admin endpoint, worker, refund webhooks).
9. Hardening and presentation: logging/correlation ids, graceful shutdown, Swagger, load script, test page, README with Mermaid sequence diagrams and the failure table.

Each phase comes with a short explanation to the author of *why* it's built that way. This is a learning project.

## 13. Builder's calls (decided by Claude, not the user)

Doc location `docs/design.md`; Postgres 17; USD only; full refunds only; 15-min expiry; admin auth = static API key header; customer = email, no accounts; Stripe faked in automated tests; email at-least-once accepted; relay lives in the api process; Mailpit for email; Swagger included; tiny static test page with Stripe Elements; retention 7 days (also for completed BullMQ jobs); 5 job attempts; expiry via a Postgres sweeper instead of delayed jobs; 1h hard expiry deadline for pending payments; failed refunds return the order to its previous status; automatic refunds don't change order status; Redis AOF on.
