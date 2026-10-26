CREATE TABLE "family_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position" bigserial NOT NULL,
	"family_id" uuid NOT NULL,
	"name" text NOT NULL,
	"photo_blob" text,
	"photo_content_type" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;