ALTER TABLE "source_run" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_run" ADD COLUMN "leased_until" timestamp with time zone;