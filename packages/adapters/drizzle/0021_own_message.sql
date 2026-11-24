-- Whether the Family sent a message itself. Expand only: a column with a default that older cores never read or write.
ALTER TABLE "source_record" ADD COLUMN "own" boolean DEFAULT false NOT NULL;