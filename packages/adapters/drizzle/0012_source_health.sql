ALTER TABLE "sources" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_error_kind" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_new_origin_at" timestamp with time zone;--> statement-breakpoint
-- Failed runs were not told apart before, so the last run counts as successful.
UPDATE "sources" SET "last_success_at" = "last_run_at", "last_new_origin_at" = (SELECT max("first_seen_at") FROM "origins" WHERE "origins"."source_id" = "sources"."id");
