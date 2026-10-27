CREATE TABLE "llm_endpoints" (
	"family_id" uuid PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"api_key_ref" text,
	"acknowledged_at" timestamp with time zone,
	"saved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"raw_message_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"blob" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"origin_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"thread" text,
	"sent_at" timestamp with time zone NOT NULL,
	"text_blob" text NOT NULL,
	"text_sha256" text NOT NULL,
	"text_size" integer NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"extracted_at" timestamp with time zone,
	CONSTRAINT "raw_messages_origin_id_unique" UNIQUE("origin_id")
);
--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "rejection" text;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "evidence" text;--> statement-breakpoint
ALTER TABLE "llm_endpoints" ADD CONSTRAINT "llm_endpoints_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_raw_message_id_raw_messages_id_fk" FOREIGN KEY ("raw_message_id") REFERENCES "public"."raw_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_messages" ADD CONSTRAINT "raw_messages_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_messages" ADD CONSTRAINT "raw_messages_origin_id_origins_id_fk" FOREIGN KEY ("origin_id") REFERENCES "public"."origins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_attachments_raw_message_id_idx" ON "message_attachments" USING btree ("raw_message_id");--> statement-breakpoint
CREATE INDEX "raw_messages_pending_idx" ON "raw_messages" USING btree ("received_at") WHERE "raw_messages"."extracted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "raw_messages_source_thread_idx" ON "raw_messages" USING btree ("source_id","thread");