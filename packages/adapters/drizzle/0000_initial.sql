-- Helper for CHECKs on arrays: whether every text is at most max_length characters long.
CREATE FUNCTION texts_within(texts TEXT[], max_length INT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE STRICT
  AS $$ SELECT coalesce(bool_and(char_length(t) <= max_length), true) FROM unnest(texts) AS t $$;--> statement-breakpoint
CREATE TABLE "admin_session" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "agenda_member" (
	"agenda_id" uuid NOT NULL,
	"family_member_id" uuid NOT NULL,
	CONSTRAINT "agenda_member_agenda_id_family_member_id_pk" PRIMARY KEY("agenda_id","family_member_id")
);
--> statement-breakpoint
CREATE TABLE "agenda" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "agenda_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"layout" text DEFAULT 'timeline' NOT NULL,
	"horizon_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agenda_layout_known" CHECK ("agenda"."layout" IN ('timeline', 'task_list')),
	CONSTRAINT "agenda_horizon_days_in_range" CHECK ("agenda"."horizon_days" BETWEEN 1 AND 31)
);
--> statement-breakpoint
CREATE TABLE "background_activity" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"kind" text NOT NULL,
	"done" integer NOT NULL,
	"total" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "background_activity_single_row" CHECK ("background_activity"."id"),
	CONSTRAINT "background_activity_kind_known" CHECK ("background_activity"."kind" IN ('polling', 'extracting')),
	CONSTRAINT "background_activity_progress" CHECK (0 <= "background_activity"."done" AND "background_activity"."done" <= "background_activity"."total")
);
--> statement-breakpoint
CREATE TABLE "catalogue_entry" (
	"source_type_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"poll_interval_seconds" integer,
	CONSTRAINT "catalogue_entry_source_type_id_entry_id_pk" PRIMARY KEY("source_type_id","entry_id"),
	CONSTRAINT "catalogue_entry_poll_interval_positive" CHECK ("catalogue_entry"."poll_interval_seconds" > 0)
);
--> statement-breakpoint
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
CREATE TABLE "family" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"recovery_kit_confirmed_at" timestamp with time zone,
	"language" text DEFAULT 'en' NOT NULL,
	"ocr_languages" text[] DEFAULT '{eng}'::text[] NOT NULL,
	"ocr_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "family_single_row" CHECK ("family"."id"),
	CONSTRAINT "family_language_known" CHECK ("family"."language" IN ('en', 'de')),
	CONSTRAINT "family_ocr_languages_not_empty" CHECK (cardinality("family"."ocr_languages") > 0)
);
--> statement-breakpoint
CREATE TABLE "family_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "family_member_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"photo_blob" text,
	"photo_content_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_member_photo_complete" CHECK ((("family_member"."photo_blob" IS NULL) = ("family_member"."photo_content_type" IS NULL))),
	CONSTRAINT "family_member_photo_content_type_known" CHECK ("family_member"."photo_content_type" IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif'))
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
CREATE TABLE "llm_endpoint" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"api_key_ref" text,
	"acknowledged_at" timestamp with time zone,
	"saved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "llm_endpoint_single_row" CHECK ("llm_endpoint"."id")
);
--> statement-breakpoint
CREATE TABLE "secret" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wrapped_data_key" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_in_failure" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sign_in_failure_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_attribute_member" (
	"attribute_id" uuid NOT NULL,
	"family_member_id" uuid NOT NULL,
	CONSTRAINT "source_attribute_member_attribute_id_family_member_id_pk" PRIMARY KEY("attribute_id","family_member_id")
);
--> statement-breakpoint
CREATE TABLE "source_attribute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "source_attribute_external_id_unique" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "source_record_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"blob" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"conversion_problem" text,
	CONSTRAINT "source_record_attachment_position_unique" UNIQUE("record_id","position"),
	CONSTRAINT "source_record_attachment_position_not_negative" CHECK ("source_record_attachment"."position" >= 0),
	CONSTRAINT "source_record_attachment_size_not_negative" CHECK ("source_record_attachment"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "source_record_attribute" (
	"record_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	CONSTRAINT "source_record_attribute_record_id_attribute_id_pk" PRIMARY KEY("record_id","attribute_id")
);
--> statement-breakpoint
CREATE TABLE "source_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"sender" text,
	"subject" text,
	"body" text,
	"stated" jsonb,
	"processed_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"link" text,
	CONSTRAINT "source_record_external_id_unique" UNIQUE("source_id","external_id"),
	CONSTRAINT "source_record_stated_kind_known" CHECK ("source_record"."stated" IS NULL OR "source_record"."stated"->>'kind' IN ('event', 'lesson')),
	CONSTRAINT "source_record_stated_is_no_message" CHECK ("source_record"."stated" IS NULL OR ("source_record"."sender" IS NULL AND "source_record"."subject" IS NULL AND "source_record"."body" IS NULL AND "source_record"."purged_at" IS NULL AND "source_record"."occurred_at" IS NULL)),
	CONSTRAINT "source_record_message_occurred" CHECK ("source_record"."stated" IS NOT NULL OR "source_record"."occurred_at" IS NOT NULL),
	CONSTRAINT "source_record_message_has_body" CHECK ("source_record"."stated" IS NOT NULL OR ("source_record"."body" IS NULL) = ("source_record"."purged_at" IS NOT NULL)),
	CONSTRAINT "source_record_purged_is_cleared" CHECK ("source_record"."purged_at" IS NULL OR ("source_record"."sender" IS NULL AND "source_record"."subject" IS NULL AND "source_record"."body" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "source_run" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"sync_cursor" jsonb,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"last_error_kind" text,
	"last_error" text,
	"last_new_record_at" timestamp with time zone,
	"invalid_records" text[] DEFAULT '{}'::text[] NOT NULL,
	"invalid_records_since" timestamp with time zone,
	"unknown_attributes" text[] DEFAULT '{}'::text[] NOT NULL,
	"unknown_attributes_since" timestamp with time zone,
	CONSTRAINT "source_run_failure_complete" CHECK ((("source_run"."failing_since" IS NULL) = ("source_run"."last_error_kind" IS NULL)) AND (("source_run"."failing_since" IS NULL) = ("source_run"."last_error" IS NULL))),
	CONSTRAINT "source_run_invalid_records_complete" CHECK ((cardinality("source_run"."invalid_records") = 0) = ("source_run"."invalid_records_since" IS NULL)),
	CONSTRAINT "source_run_unknown_attributes_complete" CHECK ((cardinality("source_run"."unknown_attributes") = 0) = ("source_run"."unknown_attributes_since" IS NULL)),
	CONSTRAINT "source_run_last_error_kind_known" CHECK ("source_run"."last_error_kind" IN ('definite', 'temporary'))
);
--> statement-breakpoint
CREATE TABLE "source_type" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "source_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_type_id" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_version" integer NOT NULL,
	"secret_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"poll_interval_seconds" integer,
	"shown" boolean DEFAULT true NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_poll_interval_positive" CHECK ("source"."poll_interval_seconds" > 0)
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
ALTER TABLE "admin_session" ADD CONSTRAINT "admin_session_admin_id_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_member" ADD CONSTRAINT "agenda_member_agenda_id_agenda_id_fk" FOREIGN KEY ("agenda_id") REFERENCES "public"."agenda"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_member" ADD CONSTRAINT "agenda_member_family_member_id_family_member_id_fk" FOREIGN KEY ("family_member_id") REFERENCES "public"."family_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_entry" ADD CONSTRAINT "catalogue_entry_source_type_id_source_type_id_fk" FOREIGN KEY ("source_type_id") REFERENCES "public"."source_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_item_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."item"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_record_id_source_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."source_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_item_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."item"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_attribute_member" ADD CONSTRAINT "source_attribute_member_attribute_id_source_attribute_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."source_attribute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_attribute_member" ADD CONSTRAINT "source_attribute_member_family_member_id_family_member_id_fk" FOREIGN KEY ("family_member_id") REFERENCES "public"."family_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_attribute" ADD CONSTRAINT "source_attribute_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_attachment" ADD CONSTRAINT "source_record_attachment_record_id_source_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."source_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_attribute" ADD CONSTRAINT "source_record_attribute_record_id_source_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."source_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Deferred, so that deleting a Source finds its Source Attributes unreferenced once its cascade is done.
ALTER TABLE "source_record_attribute" ADD CONSTRAINT "source_record_attribute_attribute_id_source_attribute_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."source_attribute"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "source_record" ADD CONSTRAINT "source_record_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_run" ADD CONSTRAINT "source_run_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_source_type_id_source_type_id_fk" FOREIGN KEY ("source_type_id") REFERENCES "public"."source_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_item_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."item"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_session_admin_id_idx" ON "admin_session" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "admin_session_expires_at_idx" ON "admin_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agenda_member_family_member_id_idx" ON "agenda_member" USING btree ("family_member_id");--> statement-breakpoint
CREATE INDEX "event_starts_at_idx" ON "event" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "event_first_day_idx" ON "event" USING btree ("first_day","last_day");--> statement-breakpoint
CREATE INDEX "item_record_id_idx" ON "item" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "lesson_starts_at_idx" ON "lesson" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "sign_in_failure_key_at_idx" ON "sign_in_failure" USING btree ("key","at");--> statement-breakpoint
CREATE INDEX "source_attribute_member_family_member_id_idx" ON "source_attribute_member" USING btree ("family_member_id");--> statement-breakpoint
CREATE INDEX "source_record_attribute_attribute_id_idx" ON "source_record_attribute" USING btree ("attribute_id");--> statement-breakpoint
CREATE INDEX "source_record_pending_idx" ON "source_record" USING btree ("created_at") WHERE "source_record"."processed_at" IS NULL AND "source_record"."stated" IS NULL AND "source_record"."withdrawn_at" IS NULL AND "source_record"."purged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "source_record_message_occurred_at_idx" ON "source_record" USING btree ("occurred_at") WHERE "source_record"."stated" IS NULL;--> statement-breakpoint
CREATE INDEX "source_source_type_id_idx" ON "source" USING btree ("source_type_id");--> statement-breakpoint
CREATE INDEX "task_status_deadline_idx" ON "task" USING btree ("status","deadline");--> statement-breakpoint
-- Triggers keep the invariants that a CHECK cannot.
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
--> statement-breakpoint
-- Deleting a Family Member: refused while a Source Attribute is assigned to them alone,
-- since its Items would silently concern the whole Family; and every Agenda whose only member they
-- are is deleted with them, so it never silently widens to the whole Family.
CREATE FUNCTION family_member_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM source_attribute_member m
    WHERE m.family_member_id = OLD.id
      AND NOT EXISTS (SELECT 1 FROM source_attribute_member o
                      WHERE o.attribute_id = m.attribute_id AND o.family_member_id <> OLD.id)
  ) THEN
    RAISE EXCEPTION 'family member % is the only assignee of a source attribute', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  DELETE FROM agenda a
  WHERE EXISTS (SELECT 1 FROM agenda_member m WHERE m.agenda_id = a.id AND m.family_member_id = OLD.id)
    AND NOT EXISTS (SELECT 1 FROM agenda_member m WHERE m.agenda_id = a.id AND m.family_member_id <> OLD.id);
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER family_member_before_delete BEFORE DELETE ON family_member
  FOR EACH ROW EXECUTE FUNCTION family_member_before_delete();
--> statement-breakpoint
-- The one row of what belongs to the Family itself.
INSERT INTO "family" DEFAULT VALUES;
