import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export default async function globalSetup() {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5434/payments_test';
  const pool = new pg.Pool({ connectionString: url });
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  await pool.end();
}
