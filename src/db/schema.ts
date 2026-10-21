import { sql } from 'drizzle-orm';
import { check, integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

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
