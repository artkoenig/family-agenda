ALTER TABLE "family_member" ADD COLUMN "colour" integer;--> statement-breakpoint
-- Those already there take the colours in the order they were added, so that the first eight differ.
UPDATE "family_member" SET "colour" = numbered.colour FROM (SELECT "id", (row_number() OVER (ORDER BY "position") - 1) % 8 + 1 AS colour FROM "family_member") AS numbered WHERE "family_member"."id" = numbered."id";--> statement-breakpoint
ALTER TABLE "family_member" ALTER COLUMN "colour" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "family_member" ADD CONSTRAINT "family_member_colour_known" CHECK ("family_member"."colour" BETWEEN 1 AND 8);
