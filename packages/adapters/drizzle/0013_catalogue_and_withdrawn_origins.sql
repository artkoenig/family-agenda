CREATE TABLE "catalogue_entries" (
	"source_type_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"first_seen_in" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "catalogue_entries_source_type_id_entry_id_pk" PRIMARY KEY("source_type_id","entry_id")
);
--> statement-breakpoint
ALTER TABLE "origins" ADD COLUMN "withdrawn_at" timestamp with time zone;