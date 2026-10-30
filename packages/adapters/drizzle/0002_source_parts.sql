ALTER TABLE "origins" ADD COLUMN "part" text;--> statement-breakpoint
ALTER TABLE "source_members" ADD COLUMN "part" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_members" DROP CONSTRAINT "source_members_source_id_family_member_id_pk";--> statement-breakpoint
ALTER TABLE "source_members" ADD CONSTRAINT "source_members_source_id_part_family_member_id_pk" PRIMARY KEY("source_id","part","family_member_id");
