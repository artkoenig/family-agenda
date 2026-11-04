-- Items are written from their one Source Record, without Revisions (ADR-0016): a base item table
-- and one detail table per kind. The Items and their Revisions are not carried over: every message
-- is read once more to write its Items, and every Source reads again from its first run.
DROP TABLE "item_keys" CASCADE;--> statement-breakpoint
DROP TABLE "items" CASCADE;--> statement-breakpoint
DROP TABLE "revisions" CASCADE;--> statement-breakpoint
UPDATE "source_record" SET "processed_at" = NULL;--> statement-breakpoint
UPDATE "source_run" SET "sync_cursor" = NULL;--> statement-breakpoint
CREATE FUNCTION texts_within(texts TEXT[], max_length INT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE STRICT
  AS $$ SELECT coalesce(bool_and(char_length(t) <= max_length), true) FROM unnest(texts) AS t $$;--> statement-breakpoint
CREATE TABLE "event" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'event' NOT NULL,
	"title" text NOT NULL,
	"location" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"first_day" date,
	"last_day" date,
	"cancelled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "event_kind" CHECK ("event"."kind" = 'event'),
	CONSTRAINT "event_title_length" CHECK (char_length("event"."title") <= 500),
	CONSTRAINT "event_location_length" CHECK (char_length("event"."location") <= 500),
	CONSTRAINT "event_one_window" CHECK (("event"."starts_at" IS NOT NULL AND "event"."ends_at" IS NOT NULL AND "event"."first_day" IS NULL AND "event"."last_day" IS NULL) OR ("event"."starts_at" IS NULL AND "event"."ends_at" IS NULL AND "event"."first_day" IS NOT NULL AND "event"."last_day" IS NOT NULL)),
	CONSTRAINT "event_time_ordered" CHECK ("event"."ends_at" >= "event"."starts_at"),
	CONSTRAINT "event_days_ordered" CHECK ("event"."last_day" >= "event"."first_day")
);
--> statement-breakpoint
CREATE TABLE "item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_id_kind_unique" UNIQUE("id","kind"),
	CONSTRAINT "item_kind_known" CHECK ("item"."kind" IN ('event', 'task', 'lesson'))
);
--> statement-breakpoint
CREATE TABLE "lesson" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'lesson' NOT NULL,
	"subject" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"room" text,
	"teacher" text,
	"change" text,
	"previous_subject" text,
	"previous_room" text,
	"previous_teacher" text,
	"note" text,
	CONSTRAINT "lesson_kind" CHECK ("lesson"."kind" = 'lesson'),
	CONSTRAINT "lesson_time_ordered" CHECK ("lesson"."ends_at" >= "lesson"."starts_at"),
	CONSTRAINT "lesson_change_known" CHECK ("lesson"."change" IN ('cancellation', 'substitution', 'room-change')),
	CONSTRAINT "lesson_previous_only_when_changed" CHECK ("lesson"."change" IS NOT NULL OR ("lesson"."previous_subject" IS NULL AND "lesson"."previous_room" IS NULL AND "lesson"."previous_teacher" IS NULL AND "lesson"."note" IS NULL)),
	CONSTRAINT "lesson_text_length" CHECK (char_length("lesson"."subject") <= 200 AND char_length("lesson"."room") <= 200 AND char_length("lesson"."teacher") <= 200 AND char_length("lesson"."previous_subject") <= 200 AND char_length("lesson"."previous_room") <= 200 AND char_length("lesson"."previous_teacher") <= 200 AND char_length("lesson"."note") <= 200)
);
--> statement-breakpoint
CREATE TABLE "task" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'task' NOT NULL,
	"title" text NOT NULL,
	"deadline" date,
	"bring" text[] DEFAULT '{}'::text[] NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "task_kind" CHECK ("task"."kind" = 'task'),
	CONSTRAINT "task_title_length" CHECK (char_length("task"."title") <= 500),
	CONSTRAINT "task_bring_count" CHECK (cardinality("task"."bring") <= 50),
	CONSTRAINT "task_bring_length" CHECK (texts_within("task"."bring", 500)),
	CONSTRAINT "task_status_known" CHECK ("task"."status" IN ('open', 'done')),
	CONSTRAINT "task_done_at_when_done" CHECK (("task"."status" = 'done') = ("task"."done_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_item_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."item"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_record_id_source_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."source_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_item_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."item"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_item_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."item"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_starts_at_idx" ON "event" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "event_first_day_idx" ON "event" USING btree ("first_day","last_day");--> statement-breakpoint
CREATE INDEX "item_record_id_idx" ON "item" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "lesson_starts_at_idx" ON "lesson" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "task_status_deadline_idx" ON "task" USING btree ("status","deadline");--> statement-breakpoint
CREATE FUNCTION source_record_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM item WHERE record_id = NEW.id;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER source_record_withdrawn AFTER UPDATE OF withdrawn_at ON source_record
  FOR EACH ROW WHEN (OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL)
  EXECUTE FUNCTION source_record_withdrawn();--> statement-breakpoint
CREATE FUNCTION item_has_detail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM item WHERE id = NEW.id) THEN
    RETURN NULL;
  END IF;
  IF NOT (CASE NEW.kind
            WHEN 'event'  THEN EXISTS (SELECT 1 FROM event  WHERE item_id = NEW.id)
            WHEN 'task'   THEN EXISTS (SELECT 1 FROM task   WHERE item_id = NEW.id)
            WHEN 'lesson' THEN EXISTS (SELECT 1 FROM lesson WHERE item_id = NEW.id)
          END) THEN
    RAISE EXCEPTION 'item % has no % row', NEW.id, NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER item_has_detail AFTER INSERT ON item
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION item_has_detail();--> statement-breakpoint
CREATE FUNCTION item_detail_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM item WHERE id = OLD.item_id) THEN
    RAISE EXCEPTION 'item % lost its % row', OLD.item_id, OLD.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER event_deleted AFTER DELETE ON event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION item_detail_deleted();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER task_deleted AFTER DELETE ON task
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION item_detail_deleted();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lesson_deleted AFTER DELETE ON lesson
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION item_detail_deleted();
