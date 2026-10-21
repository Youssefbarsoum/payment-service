import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsInt,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class OrderItemDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  @Max(2_147_483_647) // Postgres integer range: larger ids would be a 500, not a 400
  productId: number;

  @ApiProperty({ minimum: 1, maximum: 10, example: 1 })
  @IsInt()
  @Min(1)
  @Max(10)
  quantity: number;
}

export class CreateOrderDto {
  @ApiProperty({ example: 'buyer@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ type: [OrderItemDto], minItems: 1, maxItems: 20 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique((item: OrderItemDto) => item.productId, {
    message: 'each productId may appear only once',
  })
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}
