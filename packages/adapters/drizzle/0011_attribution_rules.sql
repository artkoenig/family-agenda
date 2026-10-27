CREATE TABLE "attribution_rule_members" (
	"rule_id" uuid NOT NULL,
	"family_member_id" uuid NOT NULL,
	CONSTRAINT "attribution_rule_members_rule_id_family_member_id_pk" PRIMARY KEY("rule_id","family_member_id")
);
--> statement-breakpoint
CREATE TABLE "attribution_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position" bigserial NOT NULL,
	"family_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"attribute" text NOT NULL,
	"value" text NOT NULL,
	"whole_family" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attribution_rules_source_attribute_value_unique" UNIQUE("source_id","attribute","value")
);
--> statement-breakpoint
ALTER TABLE "attribution_rule_members" ADD CONSTRAINT "attribution_rule_members_rule_id_attribution_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."attribution_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_rule_members" ADD CONSTRAINT "attribution_rule_members_family_member_id_family_members_id_fk" FOREIGN KEY ("family_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_rules" ADD CONSTRAINT "attribution_rules_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_rules" ADD CONSTRAINT "attribution_rules_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;