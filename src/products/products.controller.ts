import { Controller, Get, Inject } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module.js';
import { products } from '../db/schema.js';

@Controller('products')
export class ProductsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  list() {
    return this.db.select().from(products).orderBy(asc(products.id));
  }
}
