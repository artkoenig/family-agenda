-- The registrations received and carried through (ADR-0010). Expand only: a new table that older cores never read; processed_idp_event stays for them until a later release drops it.
CREATE TABLE "registration" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"family_id" uuid,
	"organization_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"leased_until" timestamp with time zone,
	"done_at" timestamp with time zone
);
