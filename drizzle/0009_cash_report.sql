CREATE TABLE "cash_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"system_key" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cash_categories_type_check" CHECK (type in ('income', 'expense'))
);
--> statement-breakpoint
CREATE TABLE "cash_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_on" date NOT NULL,
	"type" text NOT NULL,
	"category_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"description" text NOT NULL,
	"attachment_key" text,
	"recorded_by" text NOT NULL,
	"correction_of" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cash_transactions_amount_check" CHECK (amount > 0),
	CONSTRAINT "cash_transactions_type_check" CHECK (type in ('income', 'expense')),
	CONSTRAINT "cash_transactions_correction_self_check" CHECK (correction_of is null or correction_of <> id)
);
--> statement-breakpoint
CREATE TABLE "monthly_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_by" text NOT NULL,
	"revision_reason" text,
	"opening_balance" bigint NOT NULL,
	"total_income" bigint NOT NULL,
	"total_expense" bigint NOT NULL,
	"closing_balance" bigint NOT NULL,
	"dues_collected" bigint NOT NULL,
	"dues_units_paid" integer NOT NULL,
	"dues_units_unpaid" integer NOT NULL,
	"category_breakdown" jsonb NOT NULL,
	CONSTRAINT "monthly_reports_revision_check" CHECK (revision >= 1),
	CONSTRAINT "monthly_reports_revision_reason_check" CHECK ((revision = 1 and revision_reason is null) or (revision > 1 and revision_reason is not null)),
	CONSTRAINT "monthly_reports_balance_check" CHECK (closing_balance = opening_balance + total_income - total_expense),
	CONSTRAINT "monthly_reports_total_income_check" CHECK (total_income >= 0),
	CONSTRAINT "monthly_reports_total_expense_check" CHECK (total_expense >= 0),
	CONSTRAINT "monthly_reports_dues_collected_check" CHECK (dues_collected >= 0),
	CONSTRAINT "monthly_reports_dues_units_paid_check" CHECK (dues_units_paid >= 0),
	CONSTRAINT "monthly_reports_dues_units_unpaid_check" CHECK (dues_units_unpaid >= 0)
);
--> statement-breakpoint
CREATE TABLE "periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "periods_month_check" CHECK (month between 1 and 12),
	CONSTRAINT "periods_status_check" CHECK (status in ('open', 'locked'))
);
--> statement-breakpoint
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_category_id_cash_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "cash_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_correction_of_cash_transactions_id_fk" FOREIGN KEY ("correction_of") REFERENCES "cash_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_reports" ADD CONSTRAINT "monthly_reports_period_id_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_reports" ADD CONSTRAINT "monthly_reports_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_categories_name_unique" ON "cash_categories" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_categories_system_key_unique" ON "cash_categories" USING btree ("system_key");--> statement-breakpoint
CREATE INDEX "cash_transactions_occurred_on_idx" ON "cash_transactions" USING btree ("occurred_on");--> statement-breakpoint
CREATE INDEX "cash_transactions_category_id_idx" ON "cash_transactions" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_reports_period_id_revision_unique" ON "monthly_reports" USING btree ("period_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "periods_year_month_unique" ON "periods" USING btree ("year","month");--> statement-breakpoint
-- The two system categories, created by the migration rather than by application startup code:
-- "Iuran warga" (key `dues`) may only be written by payment verification, and "Saldo awal"
-- (key `opening-balance`) holds the single opening-balance transaction. Code finds them by
-- `system_key`; the names are data a superuser may rename. See cash-category.ts.
INSERT INTO "cash_categories" ("name", "type", "system_key", "created_at")
VALUES
	('Iuran warga', 'income', 'dues', now()),
	('Saldo awal', 'income', 'opening-balance', now());