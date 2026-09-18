CREATE TABLE "complaint_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"complaint_id" uuid NOT NULL,
	"file_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaint_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"complaint_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaint_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"complaint_id" uuid NOT NULL,
	"old_status" text NOT NULL,
	"new_status" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"note" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "complaint_status_changes_old_status_check" CHECK (old_status in ('new', 'reviewing', 'working', 'resolved', 'rejected', 'withdrawn')),
	CONSTRAINT "complaint_status_changes_new_status_check" CHECK (new_status in ('new', 'reviewing', 'working', 'resolved', 'rejected', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "complaints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"status" text NOT NULL,
	"visibility" text NOT NULL,
	"rejection_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"status_changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "complaints_status_check" CHECK (status in ('new', 'reviewing', 'working', 'resolved', 'rejected', 'withdrawn')),
	CONSTRAINT "complaints_visibility_check" CHECK (visibility in ('private', 'public')),
	CONSTRAINT "complaints_rejection_reason_check" CHECK (rejection_reason is null or status = 'rejected')
);
--> statement-breakpoint
ALTER TABLE "complaint_attachments" ADD CONSTRAINT "complaint_attachments_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_replies" ADD CONSTRAINT "complaint_replies_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_replies" ADD CONSTRAINT "complaint_replies_author_id_residents_id_fk" FOREIGN KEY ("author_id") REFERENCES "residents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_status_changes" ADD CONSTRAINT "complaint_status_changes_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_status_changes" ADD CONSTRAINT "complaint_status_changes_actor_id_residents_id_fk" FOREIGN KEY ("actor_id") REFERENCES "residents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_reporter_id_residents_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "residents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "complaint_attachments_complaint_id_idx" ON "complaint_attachments" USING btree ("complaint_id");--> statement-breakpoint
CREATE INDEX "complaint_replies_complaint_id_idx" ON "complaint_replies" USING btree ("complaint_id");--> statement-breakpoint
CREATE INDEX "complaint_status_changes_complaint_id_idx" ON "complaint_status_changes" USING btree ("complaint_id");--> statement-breakpoint
CREATE INDEX "complaints_status_idx" ON "complaints" USING btree ("status");--> statement-breakpoint
CREATE INDEX "complaints_category_idx" ON "complaints" USING btree ("category");--> statement-breakpoint
CREATE INDEX "complaints_status_changed_at_idx" ON "complaints" USING btree ("status_changed_at");