Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5434/payments_test',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  ADMIN_API_KEY: 'test-admin-key',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1026',
  MAIL_FROM: 'Payment Service <orders@example.com>',
});
