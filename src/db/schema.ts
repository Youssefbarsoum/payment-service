import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const products = pgTable(
  'products',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull().unique(),
    priceCents: integer('price_cents').notNull(),
    stock: integer('stock').notNull(),
  },
  (t) => [
    check('products_price_positive', sql`${t.priceCents} > 0`),
    // Last line of defence against overselling, even if application code is wrong.
    check('products_stock_non_negative', sql`${t.stock} >= 0`),
  ],
);

export const orderStatus = pgEnum('order_status', [
  'pending_payment',
  'paid',
  'fulfilled',
  'refund_pending',
  'refunded',
  'expired',
]);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerEmail: text('customer_email').notNull(),
    status: orderStatus('status').notNull().default('pending_payment'),
    totalCents: integer('total_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    stripePaymentIntentId: text('stripe_payment_intent_id').unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // The expiry sweeper scans pending orders by deadline.
  (t) => [index('orders_status_expires_at_idx').on(t.status, t.expiresAt)],
);

export const orderItems = pgTable(
  'order_items',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    quantity: integer('quantity').notNull(),
    // Price snapshot: later catalog price changes never alter what was charged.
    unitPriceCents: integer('unit_price_cents').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.productId] }),
    check('order_items_quantity_positive', sql`${t.quantity} > 0`),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    // Scoping by endpoint lets clients reuse one key generator across endpoints.
    endpoint: text('endpoint').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.key, t.endpoint] })],
);

/** Every Stripe event we accepted; the primary key is the dedupe guard. */
export const webhookEvents = pgTable('webhook_events', {
  stripeEventId: text('stripe_event_id').primaryKey(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

/** Audit trail: one row per payment outcome Stripe reported. */
export const payments = pgTable('payments', {
  id: serial('id').primaryKey(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id),
  stripePaymentIntentId: text('stripe_payment_intent_id').notNull(),
  stripeEventId: text('stripe_event_id').notNull().unique(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  status: text('status', { enum: ['succeeded', 'failed'] }).notNull(),
  createdAt: createdAt(),
});

/**
 * Transactional outbox: written in the same transaction as the state change it
 * describes, then relayed to the job queue. If the transaction commits, the
 * event exists; if it rolls back, the event never happened.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventType: text('event_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    index('outbox_unpublished_idx')
      .on(t.id)
      .where(sql`${t.publishedAt} is null`),
  ],
);

/**
 * Emails already sent, keyed by the job id that sent them, so a retried or
 * re-published job doesn't email the customer twice.
 */
export const sentEmails = pgTable('sent_emails', {
  dedupeKey: text('dedupe_key').primaryKey(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id),
  kind: text('kind').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
});
