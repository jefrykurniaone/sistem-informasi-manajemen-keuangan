CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "allocations_amount_check" CHECK (amount >= 0)
);
--> statement-breakpoint
CREATE TABLE "dues_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"amount" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dues_rates_amount_check" CHECK (amount >= 0)
);
--> statement-breakpoint
CREATE TABLE "exemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"started_on" date NOT NULL,
	"ended_on" date,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "exemptions_date_order_check" CHECK (ended_on is null or ended_on >= started_on)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"period" text NOT NULL,
	"amount" bigint NOT NULL,
	"due_date" date NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"voided_by" uuid,
	CONSTRAINT "invoices_amount_check" CHECK (amount >= 0),
	CONSTRAINT "invoices_period_shape_check" CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "invoices_void_check" CHECK ((voided_at is null and void_reason is null and voided_by is null) or (voided_at is not null and void_reason is not null and voided_by is not null))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"recorded_by" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"received_on" date NOT NULL,
	"method" text NOT NULL,
	"proof_file_key" text,
	"status" text NOT NULL,
	"rejection_reason" text,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_amount_check" CHECK (amount >= 0),
	CONSTRAINT "payments_method_check" CHECK (method in ('transfer', 'cash')),
	CONSTRAINT "payments_status_check" CHECK (status in ('pending', 'verified', 'rejected')),
	CONSTRAINT "payments_rejection_reason_check" CHECK (rejection_reason is null or status = 'rejected'),
	CONSTRAINT "payments_verification_check" CHECK ((verified_at is null and verified_by is null) or (verified_at is not null and verified_by is not null and status = 'verified'))
);
--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exemptions" ADD CONSTRAINT "exemptions_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exemptions" ADD CONSTRAINT "exemptions_created_by_residents_id_fk" FOREIGN KEY ("created_by") REFERENCES "residents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_residents_id_fk" FOREIGN KEY ("voided_by") REFERENCES "residents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_residents_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "residents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_verified_by_residents_id_fk" FOREIGN KEY ("verified_by") REFERENCES "residents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocations_payment_id_invoice_id_unique" ON "allocations" USING btree ("payment_id","invoice_id");--> statement-breakpoint
CREATE INDEX "allocations_invoice_id_idx" ON "allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dues_rates_effective_from_unique" ON "dues_rates" USING btree ("effective_from");--> statement-breakpoint
CREATE INDEX "exemptions_unit_id_idx" ON "exemptions" USING btree ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_unit_id_period_unique" ON "invoices" USING btree ("unit_id","period");--> statement-breakpoint
CREATE INDEX "payments_unit_id_idx" ON "payments" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");