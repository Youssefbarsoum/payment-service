import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DB, Db } from '../src/db/db.module.js';
import { products } from '../src/db/schema.js';
import { setupApp } from '../src/setup-app.js';

export async function createTestApp(): Promise<{
  app: INestApplication;
  db: Db;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  setupApp(app);
  await app.init();
  return { app, db: app.get<Db>(DB) };
}

export async function resetDb(db: Db): Promise<void> {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await db.execute(sql.raw(`truncate ${tables} restart identity cascade`));
}

export async function seedProduct(
  db: Db,
  p: { name?: string; priceCents: number; stock: number },
): Promise<number> {
  const [row] = await db
    .insert(products)
    .values({ ...p, name: p.name ?? `product-${crypto.randomUUID()}` })
    .returning({ id: products.id });
  return row.id;
}
