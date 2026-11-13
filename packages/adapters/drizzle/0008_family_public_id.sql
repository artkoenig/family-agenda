-- The Family's id outside its database, which the ticket of a plugin call names (ADR-0001).
ALTER TABLE "family" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid() NOT NULL;