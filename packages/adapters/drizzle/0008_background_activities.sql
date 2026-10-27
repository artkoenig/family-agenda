CREATE TABLE "background_activities" (
	"family_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"done" integer NOT NULL,
	"total" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "background_activities" ADD CONSTRAINT "background_activities_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;