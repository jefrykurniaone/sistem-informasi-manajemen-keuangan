CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"period" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"error" text,
	CONSTRAINT "job_runs_status_check" CHECK (status in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_claim_unique" ON "job_runs" USING btree ("job_name","period") WHERE status in ('running', 'succeeded');--> statement-breakpoint
CREATE INDEX "job_runs_job_name_started_at_idx" ON "job_runs" USING btree ("job_name","started_at");