-- The family.created webhooks not yet delivered (ADR-0010), in a supplied core's registration database. Expand only: a new table that older cores never read.
CREATE TABLE "family_created_delivery" (
	"family_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL
);
