import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiIdempotencyKey } from '../idempotency/api-idempotency-key.js';
import { DB, type Db } from '../db/db.module.js';
import { IdempotencyKey } from '../idempotency/idempotency-key.decorator.js';
import { sendIdempotent, withIdempotency } from '../idempotency/idempotency.js';
import { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { CreateOrderDto } from './orders.dto.js';
import { OrdersService } from './orders.service.js';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orders: OrdersService,
    private readonly paymentIntents: PaymentIntentsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create an order and reserve its stock for 15 minutes',
  })
  @ApiIdempotencyKey()
  @ApiResponse({
    status: 201,
    description: 'Created, or replayed for a repeated key',
  })
  @ApiResponse({ status: 409, description: 'out_of_stock' })
  @ApiResponse({ status: 422, description: 'idempotency_key_mismatch' })
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

  @Post(':id/payment-intent')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get or create the Stripe PaymentIntent (idempotent per order)',
  })
  @ApiResponse({ status: 409, description: 'order_not_payable' })
  @ApiResponse({ status: 502, description: 'payment_provider_unavailable' })
  startPayment(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentIntents.getOrCreate(id);
  }
}
