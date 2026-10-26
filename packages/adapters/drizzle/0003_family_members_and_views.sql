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
CREATE TABLE "view_preselections" (
	"view_id" uuid NOT NULL,
	"family_member_id" uuid NOT NULL,
	CONSTRAINT "view_preselections_view_id_family_member_id_pk" PRIMARY KEY("view_id","family_member_id")
);
--> statement-breakpoint
CREATE TABLE "views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position" bigserial NOT NULL,
	"family_id" uuid NOT NULL,
	"horizon_days" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_preselections" ADD CONSTRAINT "view_preselections_view_id_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_preselections" ADD CONSTRAINT "view_preselections_family_member_id_family_members_id_fk" FOREIGN KEY ("family_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;