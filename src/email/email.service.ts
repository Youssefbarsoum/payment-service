import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Transporter } from 'nodemailer';
import { CONFIG, type Env } from '../config.js';
import { DB, type Db } from '../db/db.module.js';
import { orders, sentEmails } from '../db/schema.js';
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export type EmailKind =
  'order_confirmation' | 'payment_failed' | 'refund_confirmation';

type Order = typeof orders.$inferSelect;

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);

const templates: Record<
  EmailKind,
  (o: Order) => { subject: string; text: string }
> = {
  order_confirmation: (o) => ({
    subject: `Order confirmed — #${o.id.slice(0, 8)}`,
    text: `Thanks! We received your payment of ${money(o.totalCents, o.currency)} for order ${o.id}.`,
  }),
  payment_failed: (o) => ({
    subject: `Payment failed — #${o.id.slice(0, 8)}`,
    text: `Your payment for order ${o.id} did not go through. You can try again with another card before ${o.expiresAt.toISOString()}.`,
  }),
  refund_confirmation: (o) => ({
    subject: `Refund processed — #${o.id.slice(0, 8)}`,
    text: `We refunded ${money(o.totalCents, o.currency)} for order ${o.id}. It may take a few days to appear on your statement.`,
  }),
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MAIL_TRANSPORT) private readonly transport: Transporter,
    @Inject(CONFIG) private readonly config: Env,
  ) {}

  /**
   * Sends at most once per dedupe key (the job id), as far as a database can
   * promise. Delivery is at-least-once: a crash between the SMTP send and the
   * insert re-sends that one email on retry. That trade-off is accepted;
   * the alternative of recording before sending could lose the email instead.
   */
  async sendOnce(
    dedupeKey: string,
    orderId: string,
    kind: EmailKind,
  ): Promise<'sent' | 'skipped'> {
    const [already] = await this.db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.dedupeKey, dedupeKey));
    if (already) return 'skipped';

    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!order) {
      this.logger.warn({ orderId, kind }, 'email for unknown order skipped');
      return 'skipped';
    }

    const { subject, text } = templates[kind](order);
    await this.transport.sendMail({
      from: this.config.MAIL_FROM,
      to: order.customerEmail,
      subject,
      text,
    });
    await this.db
      .insert(sentEmails)
      .values({ dedupeKey, orderId, kind })
      .onConflictDoNothing();
    return 'sent';
  }
}
