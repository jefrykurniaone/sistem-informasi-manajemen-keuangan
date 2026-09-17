CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"unit_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "occupancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"resident_id" uuid NOT NULL,
	"role" text NOT NULL,
	"started_on" date NOT NULL,
	"ended_on" date,
	"is_primary_occupant" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "occupancies_role_check" CHECK (role in ('owner', 'tenant')),
	CONSTRAINT "occupancies_date_order_check" CHECK (ended_on is null or ended_on >= started_on)
);
--> statement-breakpoint
CREATE TABLE "registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"claimed_block" text NOT NULL,
	"claimed_number" text NOT NULL,
	"status" text NOT NULL,
	"rejection_reason" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "registrations_status_check" CHECK (status in ('pending', 'approved', 'rejected')),
	CONSTRAINT "registrations_rejection_reason_check" CHECK (rejection_reason is null or status = 'rejected')
);
--> statement-breakpoint
CREATE TABLE "residents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"phone" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block" text NOT NULL,
	"number" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occupancies" ADD CONSTRAINT "occupancies_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occupancies" ADD CONSTRAINT "occupancies_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residents" ADD CONSTRAINT "residents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_unique" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "occupancies_primary_occupant_unique" ON "occupancies" USING btree ("unit_id") WHERE is_primary_occupant and ended_on is null;--> statement-breakpoint
CREATE INDEX "occupancies_unit_id_idx" ON "occupancies" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "occupancies_resident_id_idx" ON "occupancies" USING btree ("resident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_pending_email_unique" ON "registrations" USING btree ("email") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "registrations_status_created_at_idx" ON "registrations" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "residents_user_id_unique" ON "residents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_resident_id_kind_unique" ON "subscriptions" USING btree ("resident_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "units_block_number_unique" ON "units" USING btree ("block","number");