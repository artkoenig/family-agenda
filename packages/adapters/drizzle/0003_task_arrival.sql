UPDATE "items" SET "folded" = jsonb_set(
  "items"."folded",
  '{arrivedAt}',
  to_jsonb(to_char("first"."at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
)
FROM (SELECT "item_id", min("source_time") AS "at" FROM "revisions" WHERE "accepted" GROUP BY "item_id") AS "first"
WHERE "items"."id" = "first"."item_id" AND "items"."kind" = 'task' AND "items"."folded" IS NOT NULL;--> statement-breakpoint
UPDATE "items" SET
  "window_from" = (date_trunc('day', ("folded"->>'arrivedAt')::timestamptz AT TIME ZONE 'UTC') - interval '1 day') AT TIME ZONE 'UTC',
  "window_to" = (date_trunc('day', ("folded"->>'arrivedAt')::timestamptz AT TIME ZONE 'UTC') + interval '2 days') AT TIME ZONE 'UTC'
WHERE "kind" = 'task' AND jsonb_typeof("folded"->'fields'->'done') = 'string' AND ("folded"->'fields'->>'deadline') IS NULL;
