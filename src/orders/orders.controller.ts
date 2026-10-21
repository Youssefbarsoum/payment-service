import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { DB, type Db } from '../db/db.module.js';
import { IdempotencyKey } from '../idempotency/idempotency-key.decorator.js';
import { sendIdempotent, withIdempotency } from '../idempotency/idempotency.js';
import { CreateOrderDto } from './orders.dto.js';
import { OrdersService } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orders: OrdersService,
  ) {}

  @Post()
  async create(
    @IdempotencyKey() key: string,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await withIdempotency(
      this.db,
      { key, endpoint: 'POST /orders', body: dto, status: 201 },
      (tx) => this.orders.createInTx(tx, dto),
    );
    return sendIdempotent(res, result);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(id);
  }
}
