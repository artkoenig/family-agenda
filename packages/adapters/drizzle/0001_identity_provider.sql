CREATE TABLE "identity_provider" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"enabled" boolean NOT NULL,
	"issuer_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_ref" text,
	"required_group" text NOT NULL,
	"public_base_url" text NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "identity_provider_single_row" CHECK ("identity_provider"."id")
);
--> statement-breakpoint
ALTER TABLE "admin" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin" ADD COLUMN "identity_subject" text;--> statement-breakpoint
ALTER TABLE "admin" ADD CONSTRAINT "admin_identity_subject_unique" UNIQUE("identity_subject");