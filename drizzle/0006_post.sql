CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body_markdown" text NOT NULL,
	"cover_image_key" text,
	"category" text NOT NULL,
	"status" text NOT NULL,
	"author_id" uuid NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"location" text,
	CONSTRAINT "posts_type_check" CHECK (type in ('event', 'announcement')),
	CONSTRAINT "posts_status_check" CHECK (status in ('draft', 'published', 'archived')),
	CONSTRAINT "posts_time_order_check" CHECK (starts_at is null or ends_at is null or ends_at >= starts_at)
);
--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_residents_id_fk" FOREIGN KEY ("author_id") REFERENCES "residents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_status_idx" ON "posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "posts_type_idx" ON "posts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "posts_category_idx" ON "posts" USING btree ("category");--> statement-breakpoint
CREATE INDEX "posts_starts_at_idx" ON "posts" USING btree ("starts_at");