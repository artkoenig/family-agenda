-- The id of the Family's organization in the Identity Provider (ADR-0010). Expand only: a nullable column that older cores never read.
ALTER TABLE "family" ADD COLUMN "organization_id" text;
