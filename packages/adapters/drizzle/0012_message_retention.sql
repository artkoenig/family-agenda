ALTER TABLE "source_record" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
-- A withdrawn message already lost its text and attachments.
UPDATE "source_record" SET "purged_at" = "withdrawn_at" WHERE "stated" IS NULL AND "body" IS NULL;--> statement-breakpoint
CREATE INDEX "source_record_message_occurred_at_idx" ON "source_record" USING btree ("occurred_at") WHERE "source_record"."stated" IS NULL;--> statement-breakpoint
ALTER TABLE "source_record" ADD CONSTRAINT "source_record_message_has_body" CHECK ("source_record"."stated" IS NOT NULL OR ("source_record"."body" IS NULL) = ("source_record"."purged_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "source_record" ADD CONSTRAINT "source_record_purged_is_cleared" CHECK ("source_record"."purged_at" IS NULL OR ("source_record"."sender" IS NULL AND "source_record"."subject" IS NULL AND "source_record"."body" IS NULL));--> statement-breakpoint
ALTER TABLE "source_record" ADD CONSTRAINT "source_record_stated_is_not_purged" CHECK ("source_record"."stated" IS NULL OR "source_record"."purged_at" IS NULL);