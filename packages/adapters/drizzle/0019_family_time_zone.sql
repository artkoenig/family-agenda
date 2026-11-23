-- The Family's time zone, an Admin's setting (#500). Expand only: a nullable column that older cores never read; the core stores the starting value when it prepares or opens the Family.
ALTER TABLE "family" ADD COLUMN "time_zone" text;
