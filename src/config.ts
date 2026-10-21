import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  validateSync,
} from 'class-validator';

export class Env {
  @IsIn(['development', 'production', 'test'])
  NODE_ENV: 'development' | 'production' | 'test' = 'development';

  // Explicit type annotations matter: implicit conversion reads the emitted design:type metadata.
  @IsInt()
  PORT: number = 3000;

  @IsString() @IsNotEmpty() DATABASE_URL: string;
  @IsString() @IsNotEmpty() REDIS_URL: string;
  @IsString() @IsNotEmpty() STRIPE_SECRET_KEY: string;
  @IsString() @IsNotEmpty() STRIPE_PUBLISHABLE_KEY: string;
  @IsString() @IsNotEmpty() STRIPE_WEBHOOK_SECRET: string;
  @IsString() @IsNotEmpty() ADMIN_API_KEY: string;
  @IsString() @IsNotEmpty() SMTP_HOST: string;
  @IsInt() SMTP_PORT: number;
  @IsString() @IsNotEmpty() MAIL_FROM: string;
}

export const CONFIG = Symbol('CONFIG');

/** Validates the environment once at startup: a bad deploy fails fast instead of at the first payment. */
export function loadConfig(env: Record<string, string | undefined>): Env {
  const config = plainToInstance(Env, env, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });
  const errors = validateSync(config);
  if (errors.length > 0) {
    const keys = errors.map((e) => e.property).join(', ');
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  return config;
}
