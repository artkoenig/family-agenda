CREATE TABLE "item_keys" (
	"source_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"item_id" uuid NOT NULL,
	CONSTRAINT "item_keys_source_id_item_key_pk" PRIMARY KEY("source_id","item_key")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"folded" jsonb,
	"window_from" timestamp with time zone,
	"window_to" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "origins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"attributes" jsonb NOT NULL,
	"link" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "origins_source_external_id_unique" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"family_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"origin_id" uuid NOT NULL,
	"act" text NOT NULL,
	"fields" jsonb NOT NULL,
	"source_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"accepted" boolean NOT NULL,
	"fingerprint" text NOT NULL,
	CONSTRAINT "revisions_origin_fingerprint_unique" UNIQUE("origin_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "poll_interval_seconds" integer;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item_keys" ADD CONSTRAINT "item_keys_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origins" ADD CONSTRAINT "origins_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_origin_id_origins_id_fk" FOREIGN KEY ("origin_id") REFERENCES "public"."origins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_family_window_idx" ON "items" USING btree ("family_id","window_from","window_to");--> statement-breakpoint
CREATE INDEX "revisions_item_id_idx" ON "revisions" USING btree ("item_id");