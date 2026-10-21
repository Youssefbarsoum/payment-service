import {
  Controller,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AdminGuard } from '../admin/admin.guard.js';
import { DB, type Db } from '../db/db.module.js';
import { ApiIdempotencyKey } from '../idempotency/api-idempotency-key.js';
import { IdempotencyKey } from '../idempotency/idempotency-key.decorator.js';
import { sendIdempotent, withIdempotency } from '../idempotency/idempotency.js';
import { RefundsService } from './refunds.service.js';

@ApiTags('admin')
@ApiSecurity('admin')
@Controller('orders')
@UseGuards(AdminGuard)
export class RefundsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly refunds: RefundsService,
  ) {}

  @Post(':id/refunds')
  @ApiOperation({ summary: 'Request a full refund (processed asynchronously)' })
  @ApiIdempotencyKey()
  @ApiResponse({ status: 202, description: 'Refund requested' })
  @ApiResponse({ status: 409, description: 'order_not_refundable' })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await withIdempotency(
      this.db,
      // The order id is part of the hashed body, so one key can't be replayed against another order.
      {
        key,
        endpoint: 'POST /orders/:id/refunds',
        body: { orderId: id },
        status: 202,
      },
      (tx) => this.refunds.requestAdminRefund(tx, id),
    );
    return sendIdempotent(res, result);
  }
}
