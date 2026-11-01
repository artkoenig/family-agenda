-- Origins and raw messages become one source_record per (source_id, external_id), and message
-- attachments its source_record_attachment rows (ADR-0016). The files stay in the BlobStore; the
-- raw file is the text file of the raw message. A record keeps its Origin's id, so that the
-- Revisions keep pointing at it. Records from before have no body: it is only in their raw file.
CREATE TABLE "source_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"sender" text,
	"subject" text,
	"body" text,
	"raw_blob" text,
	"raw_sha256" text,
	"raw_size" integer,
	"processed_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"link" text,
	"part" text,
	"thread" text,
	CONSTRAINT "source_record_external_id_unique" UNIQUE("source_id","external_id"),
	CONSTRAINT "source_record_raw_complete" CHECK (("source_record"."raw_blob" IS NULL) = ("source_record"."raw_sha256" IS NULL) AND ("source_record"."raw_blob" IS NULL) = ("source_record"."raw_size" IS NULL)),
	CONSTRAINT "source_record_raw_size_not_negative" CHECK ("source_record"."raw_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "source_record_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"blob" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"conversion_problem" text,
	CONSTRAINT "source_record_attachment_position_unique" UNIQUE("record_id","position"),
	CONSTRAINT "source_record_attachment_position_not_negative" CHECK ("source_record_attachment"."position" >= 0),
	CONSTRAINT "source_record_attachment_size_not_negative" CHECK ("source_record_attachment"."size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "source_record" ADD CONSTRAINT "source_record_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_attachment" ADD CONSTRAINT "source_record_attachment_record_id_source_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."source_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_record_pending_idx" ON "source_record" USING btree ("created_at") WHERE "source_record"."processed_at" IS NULL AND "source_record"."raw_blob" IS NOT NULL AND "source_record"."withdrawn_at" IS NULL;--> statement-breakpoint
CREATE INDEX "source_record_thread_idx" ON "source_record" USING btree ("source_id","thread");--> statement-breakpoint
INSERT INTO "source_record" ("id", "source_id", "external_id", "occurred_at", "sender", "raw_blob", "raw_sha256", "raw_size", "processed_at", "withdrawn_at", "created_at", "attributes", "link", "part", "thread")
SELECT o."id", o."source_id", o."external_id", coalesce(m."sent_at", o."first_seen_at"), nullif(o."attributes"->>'sender', ''),
       m."text_blob", m."text_sha256", m."text_size", m."extracted_at", o."withdrawn_at", o."first_seen_at", o."attributes", o."link", o."part", m."thread"
FROM "origins" o LEFT JOIN "raw_messages" m ON m."origin_id" = o."id";--> statement-breakpoint
INSERT INTO "source_record_attachment" ("record_id", "position", "filename", "media_type", "blob", "sha256", "size", "conversion_problem")
SELECT "raw_message_id", "position", "filename", "content_type", "blob", "sha256", "size", "conversion_problem" FROM "message_attachments";--> statement-breakpoint
ALTER TABLE "revisions" DROP CONSTRAINT "revisions_origin_id_origins_id_fk";--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_origin_id_source_record_id_fk" FOREIGN KEY ("origin_id") REFERENCES "public"."source_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP TABLE "message_attachments";--> statement-breakpoint
DROP TABLE "raw_messages";--> statement-breakpoint
DROP TABLE "origins";
