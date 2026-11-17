-- The Identity Provider's events processed (ADR-0010). Expand only: a new table that older cores never read.
CREATE TABLE "processed_idp_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone NOT NULL
);
