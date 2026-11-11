-- A Task's things to bring become its description, one "- " line per thing, in its row and in
-- what its Source states.
ALTER TABLE "task" ADD COLUMN "description" text;--> statement-breakpoint
UPDATE "task" SET "description" = left((SELECT string_agg('- ' || thing, E'\n' ORDER BY n) FROM unnest("bring") WITH ORDINALITY AS things(thing, n)), 2000) WHERE cardinality("bring") > 0;--> statement-breakpoint
UPDATE "source_record" SET "stated" = ("stated" - 'bring') || jsonb_build_object('description', (SELECT left(string_agg('- ' || thing, E'\n' ORDER BY n), 2000) FROM jsonb_array_elements_text("stated"->'bring') WITH ORDINALITY AS things(thing, n))) WHERE "stated"->>'kind' = 'task' AND jsonb_typeof("stated"->'bring') = 'array';--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_bring_count";--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_bring_length";--> statement-breakpoint
ALTER TABLE "task" DROP COLUMN "bring";--> statement-breakpoint
DROP FUNCTION texts_within(TEXT[], INT);--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_description_length" CHECK (char_length("task"."description") <= 2000);
