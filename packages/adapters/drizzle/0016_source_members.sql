CREATE TABLE "source_members" (
	"source_id" uuid NOT NULL,
	"family_member_id" uuid NOT NULL,
	CONSTRAINT "source_members_source_id_family_member_id_pk" PRIMARY KEY("source_id","family_member_id")
);
--> statement-breakpoint
ALTER TABLE "source_members" ADD CONSTRAINT "source_members_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_members" ADD CONSTRAINT "source_members_family_member_id_family_members_id_fk" FOREIGN KEY ("family_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A Source is assigned to the Family Members its Attribution Rules named; a rule for the whole Family leaves it to no one.
INSERT INTO "source_members" ("source_id", "family_member_id")
SELECT DISTINCT r."source_id", m."family_member_id"
FROM "attribution_rules" r JOIN "attribution_rule_members" m ON m."rule_id" = r."id"
WHERE NOT r."whole_family";--> statement-breakpoint
DROP TABLE "attribution_rule_members" CASCADE;--> statement-breakpoint
DROP TABLE "attribution_rules" CASCADE;
