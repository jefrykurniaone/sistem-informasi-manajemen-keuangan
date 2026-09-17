CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_roles_role_check" CHECK (role in ('resident', 'admin', 'superuser'))
);
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_target_id_idx" ON "audit_log" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_user_id_role_unique" ON "user_roles" USING btree ("user_id","role");--> statement-breakpoint
CREATE INDEX "user_roles_user_id_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
-- Every "user" row gets a "resident" row here the moment it exists, whichever code path created
-- it — better-auth's sign-up, a script, a future admin-created-account feature. This is a database
-- trigger rather than an application-level hook because src/lib/server/auth.ts, the only place a
-- sign-up happens today, is a read for this ticket, not a write; a trigger also holds for every
-- future way a "user" row comes to exist, not only the one hook a callback could reach.
-- "created_at" has no Clock to be handed here, unlike every role change the service layer writes,
-- so it is stamped with the database's own "now()" instead — see src/lib/server/db/schema/authz.ts.
CREATE FUNCTION "user_created_gets_resident_role"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "user_roles" ("id", "user_id", "role", "created_at")
	VALUES (gen_random_uuid(), NEW."id", 'resident', now());
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "user_created_gets_resident_role_trigger"
AFTER INSERT ON "user"
FOR EACH ROW
EXECUTE FUNCTION "user_created_gets_resident_role"();