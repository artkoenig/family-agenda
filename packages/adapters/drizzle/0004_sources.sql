CREATE TABLE "source_types" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"first_seen_in" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"is_new" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position" bigserial NOT NULL,
	"family_id" uuid NOT NULL,
	"source_type_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_version" integer NOT NULL,
	"secret_refs" jsonb NOT NULL,
	"state" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sources_source_type_id_idx" ON "sources" USING btree ("source_type_id");