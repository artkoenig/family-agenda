-- Admins exist only in the Identity Provider (ADR-0009): no Admin table, no password sign-in and its failures. A plain cut with no expand/contract stage, as ADR-0009 allows; sessions started before it end, and Admins sign in again.
DELETE FROM "admin_session";--> statement-breakpoint
ALTER TABLE "admin_session" DROP CONSTRAINT "admin_session_admin_id_admin_id_fk";--> statement-breakpoint
DROP INDEX "admin_session_admin_id_idx";--> statement-breakpoint
ALTER TABLE "admin_session" DROP COLUMN "admin_id";--> statement-breakpoint
ALTER TABLE "admin_session" ADD COLUMN "subject" text NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_session" ADD COLUMN "email" text NOT NULL;--> statement-breakpoint
DROP TABLE "admin";--> statement-breakpoint
DROP TABLE "sign_in_failure";
