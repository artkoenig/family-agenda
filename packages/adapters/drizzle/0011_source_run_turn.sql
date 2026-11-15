-- The run of a Source under way, so that the runs of one Source take turns across api containers; a turn whose expiry passed is over.
CREATE TABLE "source_run_turn" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"holder" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_run_turn" ADD CONSTRAINT "source_run_turn_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;