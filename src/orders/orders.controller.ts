import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { DB, type Db } from '../db/db.module.js';
import { CreateOrderDto } from './orders.dto.js';
import { OrdersService } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orders: OrdersService,
  ) {}

  @Post()
  create(@Body() dto: CreateOrderDto) {
    return this.db.transaction((tx) => this.orders.createInTx(tx, dto));
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(id);
  }
}
