import { loadConfig } from './config.js';

const validEnv = () => ({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  ADMIN_API_KEY: 'admin',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  MAIL_FROM: 'orders@example.com',
});

describe('loadConfig', () => {
  it('throws naming every missing required key', () => {
    expect(() => loadConfig({})).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('defaults PORT to 3000 and coerces numbers', () => {
    const config = loadConfig(validEnv());
    expect(config.PORT).toBe(3000);
    expect(config.SMTP_PORT).toBe(1025);
  });

  it('coerces PORT from its string env value', () => {
    expect(loadConfig({ ...validEnv(), PORT: '8080' }).PORT).toBe(8080);
  });
});
