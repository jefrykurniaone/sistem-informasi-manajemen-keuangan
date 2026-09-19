CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"cash_transaction_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"refunded_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "refunds_amount_check" CHECK (amount > 0)
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_cash_transaction_id_cash_transactions_id_fk" FOREIGN KEY ("cash_transaction_id") REFERENCES "cash_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_refunded_by_user_id_fk" FOREIGN KEY ("refunded_by") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_cash_transaction_id_unique" ON "refunds" USING btree ("cash_transaction_id");--> statement-breakpoint
CREATE INDEX "refunds_payment_id_idx" ON "refunds" USING btree ("payment_id");