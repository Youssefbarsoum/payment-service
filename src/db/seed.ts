import '../load-env.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { products } from './schema.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await drizzle(pool)
  .insert(products)
  .values([
    { name: 'Mechanical Keyboard', priceCents: 12_900, stock: 25 },
    { name: 'Noise-Cancelling Headphones', priceCents: 24_900, stock: 10 },
    // Stock of 1: try buying it from two tabs at once.
    { name: 'Limited Edition Print', priceCents: 4_500, stock: 1 },
  ])
  .onConflictDoNothing({ target: products.name });
await pool.end();
console.log('seed complete');
