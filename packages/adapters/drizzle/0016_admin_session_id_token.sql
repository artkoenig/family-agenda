-- The ID token of an Admin session, to sign out at the Identity Provider too (RP-initiated logout). Expand only: a nullable column that older cores neither write nor read.
ALTER TABLE "admin_session" ADD COLUMN "id_token" text;
