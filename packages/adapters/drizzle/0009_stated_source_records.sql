-- Calendars and timetables state their Items on the Source Record (ADR-0016): a stated Source
-- Record has no time of its own and no message, and a stated Item failing a check is a warning on
-- source_run. The entries the core translated from Revisions until now are deleted with their
-- Items, a message always having a body until it is withdrawn, and their Sources read again from
-- the first run, stating every entry whole.
WITH "entries" AS (
  DELETE FROM "source_record" WHERE "body" IS NULL AND "withdrawn_at" IS NULL RETURNING "source_id"
)
UPDATE "source_run" SET "sync_cursor" = NULL WHERE "source_id" IN (SELECT "source_id" FROM "entries");--> statement-breakpoint
ALTER TABLE "source_record" ALTER COLUMN "occurred_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_record" ADD COLUMN "stated" jsonb;--> statement-breakpoint
ALTER TABLE "source_run" ADD COLUMN "invalid_records" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "source_run" ADD COLUMN "invalid_records_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_record" ADD CONSTRAINT "source_record_stated_kind_known" CHECK ("source_record"."stated" IS NULL OR "source_record"."stated"->>'kind' IN ('event', 'lesson'));--> statement-breakpoint
ALTER TABLE "source_record" ADD CONSTRAINT "source_record_stated_is_no_message" CHECK ("source_record"."stated" IS NULL OR ("source_record"."sender" IS NULL AND "source_record"."subject" IS NULL AND "source_record"."body" IS NULL AND "source_record"."occurred_at" IS NULL));--> statement-breakpoint
ALTER TABLE "source_record" ADD CONSTRAINT "source_record_message_occurred" CHECK ("source_record"."stated" IS NOT NULL OR "source_record"."occurred_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "source_run" ADD CONSTRAINT "source_run_invalid_records_complete" CHECK ((cardinality("source_run"."invalid_records") = 0) = ("source_run"."invalid_records_since" IS NULL));