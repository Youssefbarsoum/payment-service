CREATE TYPE "public"."refund_reason" AS ENUM('admin', 'late_payment', 'amount_mismatch');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('requested', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"stripe_payment_intent_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" "refund_reason" NOT NULL,
	"status" "refund_status" DEFAULT 'requested' NOT NULL,
	"previous_order_status" "order_status",
	"stripe_refund_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_stripe_refund_id_unique" UNIQUE("stripe_refund_id")
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_one_active_per_order" ON "refunds" USING btree ("order_id") WHERE "refunds"."status" in ('requested', 'succeeded');