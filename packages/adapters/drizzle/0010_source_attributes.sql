-- Source Attributes replace Parts and the per-Source Assignment (ADR-0016). Assignments are lost,
-- as there is no data migration for them, and the Source Records already recorded carry no Source
-- Attribute yet. Every Source reads again from the start: its plugin declares its Source
-- Attributes, and what it emits again, also a message it has recorded, is attached to them.
UPDATE "source_run" SET "sync_cursor" = NULL;--> statement-breakpoint
CREATE TABLE "source_attribute_member" (
	"attribute_id" uuid NOT NULL,
	"family_member_id" uuid NOT NULL,
	CONSTRAINT "source_attribute_member_attribute_id_family_member_id_pk" PRIMARY KEY("attribute_id","family_member_id")
);
--> statement-breakpoint
CREATE TABLE "source_attribute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "source_attribute_external_id_unique" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "source_record_attribute" (
	"record_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	CONSTRAINT "source_record_attribute_record_id_attribute_id_pk" PRIMARY KEY("record_id","attribute_id")
);
--> statement-breakpoint
ALTER TABLE "source_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "source_members" CASCADE;--> statement-breakpoint
ALTER TABLE "source_run" ADD COLUMN "unknown_attributes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "source_run" ADD COLUMN "unknown_attributes_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_attribute_member" ADD CONSTRAINT "source_attribute_member_attribute_id_source_attribute_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."source_attribute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_attribute_member" ADD CONSTRAINT "source_attribute_member_family_member_id_family_member_id_fk" FOREIGN KEY ("family_member_id") REFERENCES "public"."family_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_attribute" ADD CONSTRAINT "source_attribute_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_attribute" ADD CONSTRAINT "source_record_attribute_record_id_source_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."source_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_attribute" ADD CONSTRAINT "source_record_attribute_attribute_id_source_attribute_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."source_attribute"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "source_attribute_member_family_member_id_idx" ON "source_attribute_member" USING btree ("family_member_id");--> statement-breakpoint
CREATE INDEX "source_record_attribute_attribute_id_idx" ON "source_record_attribute" USING btree ("attribute_id");--> statement-breakpoint
ALTER TABLE "source_record" DROP COLUMN "attributes";--> statement-breakpoint
ALTER TABLE "source_record" DROP COLUMN "part";--> statement-breakpoint
ALTER TABLE "source_run" ADD CONSTRAINT "source_run_unknown_attributes_complete" CHECK ((cardinality("source_run"."unknown_attributes") = 0) = ("source_run"."unknown_attributes_since" IS NULL));