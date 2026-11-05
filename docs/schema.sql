-- Target Postgres schema of the data model decided in ADR-0016.
--
-- This document is the reference for the implementation tickets. It is not a migration: there is
-- no data migration, and existing Instances start over (ADR-0016). Conventions (ADR-0014, as
-- amended by ADR-0016):
--   - singular table names;
--   - closed lists are CHECK (... IN (...)), never enum types;
--   - orders are identity columns;
--   - single-row tables have a boolean key held at true by a check (ADR-0013);
--   - UUID keys default to gen_random_uuid(), and the app may pass its own id;
--   - attachments are files behind the BlobStore (ADR-0006); Postgres holds their reference,
--     hash and size, never BYTEA content. A message's text is in Postgres, with no file;
--   - secrets are referenced without foreign keys, as the SecretStore is its own port (ADR-0006).
--
-- Files and secrets outside Postgres (ADR-0016). They are referred to only by:
--   files:   source_record_attachment.blob, family_member.photo_blob;
--   secrets: source.secret_refs (its values), llm_endpoint.api_key_ref, identity_provider.client_secret_ref.
-- No foreign key or trigger follows them. A transaction that drops such a reference, also through
-- a cascade (e.g. deleting a source), returns the references it read before deleting, and the
-- caller removes the files and secrets after the commit. The worker's sweep, at start and daily,
-- removes every file and secret that none of these columns refers to and that is older than an
-- hour.

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- Whether every text of an array is at most max_length characters long (for CHECKs on arrays).
CREATE FUNCTION texts_within(texts TEXT[], max_length INT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE STRICT
  AS $$ SELECT coalesce(bool_and(char_length(t) <= max_length), true) FROM unnest(texts) AS t $$;

-- ---------------------------------------------------------------------------------------------
-- The Family and the Instance
-- ---------------------------------------------------------------------------------------------

-- The one row holding what belongs to the Family itself (ADR-0013: still no Family id).
CREATE TABLE family (
  id                         BOOLEAN PRIMARY KEY DEFAULT true,
  language                   TEXT NOT NULL DEFAULT 'en',
  ocr_enabled                BOOLEAN NOT NULL DEFAULT true,
  ocr_languages              TEXT[] NOT NULL DEFAULT '{eng}',
  recovery_kit_confirmed_at  TIMESTAMPTZ,
  CONSTRAINT family_single_row CHECK (id),
  CONSTRAINT family_language_known CHECK (language IN ('en', 'de')),
  CONSTRAINT family_ocr_languages_not_empty CHECK (cardinality(ocr_languages) > 0)
);
INSERT INTO family DEFAULT VALUES;

CREATE TABLE admin (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL CONSTRAINT admin_email_unique UNIQUE,
  password_hash  TEXT,                     -- null: signs in only through the Identity Provider
  identity_subject TEXT CONSTRAINT admin_identity_subject_unique UNIQUE, -- the IdP `sub`
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_session (
  id          TEXT PRIMARY KEY,
  admin_id    UUID NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX admin_session_admin_id_idx ON admin_session (admin_id);
CREATE INDEX admin_session_expires_at_idx ON admin_session (expires_at);

-- Failed sign-ins, counted per key (an account or a client).
CREATE TABLE sign_in_failure (
  id   BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  key  TEXT NOT NULL,
  at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX sign_in_failure_key_at_idx ON sign_in_failure (key, at);

-- Envelope-encrypted credentials (ADR-0006). Referred to by id, without foreign keys.
CREATE TABLE secret (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wrapped_data_key  BYTEA NOT NULL,
  ciphertext        BYTEA NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE identity_provider (
  id                BOOLEAN PRIMARY KEY DEFAULT true,
  enabled           BOOLEAN NOT NULL,
  issuer_url        TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  client_secret_ref TEXT,                    -- a secret.id
  required_group    TEXT NOT NULL,
  public_base_url   TEXT NOT NULL,
  saved_at          TIMESTAMPTZ NOT NULL,
  CONSTRAINT identity_provider_single_row CHECK (id)
);

CREATE TABLE llm_endpoint (
  id               BOOLEAN PRIMARY KEY DEFAULT true,
  base_url         TEXT NOT NULL,
  model            TEXT NOT NULL,
  api_key_ref      TEXT,                     -- a secret.id
  acknowledged_at  TIMESTAMPTZ,
  saved_at         TIMESTAMPTZ NOT NULL,
  CONSTRAINT llm_endpoint_single_row CHECK (id)
);

-- What the worker is busy with, shown as progress on Agendas.
CREATE TABLE background_activity (
  id          BOOLEAN PRIMARY KEY DEFAULT true,
  kind        TEXT NOT NULL,
  done        INT NOT NULL,
  total       INT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  CONSTRAINT background_activity_single_row CHECK (id),
  CONSTRAINT background_activity_kind_known CHECK (kind IN ('polling', 'extracting')),
  CONSTRAINT background_activity_progress CHECK (0 <= done AND done <= total)
);

-- ---------------------------------------------------------------------------------------------
-- Family Members
-- ---------------------------------------------------------------------------------------------

CREATE TABLE family_member (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position            BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY,
  name                TEXT NOT NULL,
  photo_blob          TEXT,                  -- BlobStore reference
  photo_content_type  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT family_member_photo_complete
    CHECK ((photo_blob IS NULL) = (photo_content_type IS NULL)),
  CONSTRAINT family_member_photo_content_type_known
    CHECK (photo_content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif'))
);
-- Deleting a Family Member: see the trigger family_member_before_delete at the end.

-- ---------------------------------------------------------------------------------------------
-- Source Types and Sources (ADR-0010)
-- ---------------------------------------------------------------------------------------------

-- One row per discovered plugin. A newly discovered one appears disabled; there is no "new" mark.
CREATE TABLE source_type (
  id       TEXT PRIMARY KEY,                 -- the plugin's stable Source Type id
  enabled  BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE catalogue_entry (
  source_type_id         TEXT NOT NULL REFERENCES source_type(id),
  entry_id               TEXT NOT NULL,
  enabled                BOOLEAN NOT NULL DEFAULT false,
  poll_interval_seconds  INT,
  PRIMARY KEY (source_type_id, entry_id),
  CONSTRAINT catalogue_entry_poll_interval_positive CHECK (poll_interval_seconds > 0)
);

-- Only what an Admin configures. How the runs went is in source_run.
-- config holds the plugin's plain fields, including the allow-lists (`folders`, `chats`) that
-- pre-filter what is read; there is no `parts` field.
CREATE TABLE source (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position               BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY,
  source_type_id         TEXT NOT NULL REFERENCES source_type(id),
  name                   TEXT NOT NULL,
  config                 JSONB NOT NULL DEFAULT '{}',
  config_version         INT NOT NULL,
  secret_refs            JSONB NOT NULL DEFAULT '{}',  -- field name -> secret.id
  poll_interval_seconds  INT,
  shown                  BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT source_poll_interval_positive CHECK (poll_interval_seconds > 0)
);
CREATE INDEX source_source_type_id_idx ON source (source_type_id);

-- Run state, one row per Source, written by the worker on every run (ADR-0014).
-- sync_cursor is written in the same transaction as the run's Source Records. For ICS and WebUntis it
-- holds only the ETag and the set of known external ids, from which the plugin reports vanished
-- entries as withdrawn.
--
-- Two warnings sit beside the Source Status (OK / Failing / Silent), never a state of their own:
--   unknown_attributes: Source Attribute external ids that refused Source Records named although they
--     were unknown or archived (a plugin bug). Cleared by a run that refuses no Source Record, or by a
--     declare covering the ids.
--   invalid_records: external ids of Source Records whose stated Item failed a CHECK, so no Item was
--     written. An id leaves the list when its Source Record writes its Item or is withdrawn.
CREATE TABLE source_run (
  source_id                 UUID PRIMARY KEY REFERENCES source(id) ON DELETE CASCADE,
  sync_cursor               JSONB,
  last_run_at               TIMESTAMPTZ,
  last_success_at           TIMESTAMPTZ,
  failing_since             TIMESTAMPTZ,
  last_error_kind           TEXT,
  last_error                TEXT,
  last_new_record_at        TIMESTAMPTZ,    -- read by the Silent status
  unknown_attributes        TEXT[] NOT NULL DEFAULT '{}',
  unknown_attributes_since  TIMESTAMPTZ,
  invalid_records           TEXT[] NOT NULL DEFAULT '{}',
  invalid_records_since     TIMESTAMPTZ,
  CONSTRAINT source_run_failure_complete
    CHECK ((failing_since IS NULL) = (last_error_kind IS NULL)
       AND (failing_since IS NULL) = (last_error IS NULL)),
  CONSTRAINT source_run_last_error_kind_known
    CHECK (last_error_kind IN ('definite', 'temporary')),
  CONSTRAINT source_run_unknown_attributes_complete
    CHECK ((cardinality(unknown_attributes) = 0) = (unknown_attributes_since IS NULL)),
  CONSTRAINT source_run_invalid_records_complete
    CHECK ((cardinality(invalid_records) = 0) = (invalid_records_since IS NULL))
);

-- ---------------------------------------------------------------------------------------------
-- Source Attributes and their assignment
-- ---------------------------------------------------------------------------------------------

-- A subdivision of a Source: an IMAP folder or Gmail label, a WhatsApp group (by its JID, not the
-- Matrix room id), the one constant attribute of an ICS calendar, a child of a WebUntis account.
-- Written only through the plugin's port, never by the core on its own:
--   declare([{ externalId, name }]): inserts, or for a known externalId overwrites name and sets
--     archived_at back to NULL, keeping its source_attribute_member rows;
--   archive(externalId): sets archived_at.
-- Only allow-listed folders, labels and chats are declared. A Source without subdivisions
-- declares exactly one. Rows are archived, never deleted, except with their Source.
CREATE TABLE source_attribute (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  archived_at  TIMESTAMPTZ,
  CONSTRAINT source_attribute_external_id_unique UNIQUE (source_id, external_id)
);

-- The only place where Family Members are assigned. A Source Attribute with
-- no rows is assigned to the whole Family.
CREATE TABLE source_attribute_member (
  attribute_id      UUID NOT NULL REFERENCES source_attribute(id) ON DELETE CASCADE,
  family_member_id  UUID NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
  PRIMARY KEY (attribute_id, family_member_id)
);
CREATE INDEX source_attribute_member_family_member_id_idx
  ON source_attribute_member (family_member_id);

-- ---------------------------------------------------------------------------------------------
-- Source Records
-- ---------------------------------------------------------------------------------------------

-- One Source Record: what a Source delivered under one external id.
--
-- A message (mail, Messenger message): stated IS NULL. Its text is in body (empty for a message
-- of attachments only), its attachments behind the BlobStore; there is no file of the message
-- itself. It is read once by the LLM, and processed_at is set when its Items are written. NULL
-- means waiting, or extraction keeps failing (an Admin can retry it while its content is kept). An edited message (same external_id, new content) keeps its first reading.
--
-- A calendar entry or a Lesson (ICS UID, WebUntis `<childId>/<lessonId>`): stated holds the Item
-- as the plugin states it, e.g. {"kind": "event", "title": ..., "starts_at": ...}. No file, no
-- sender/subject/body, occurred_at NULL. The core writes its one Item from it without the LLM,
-- in the same transaction that sets processed_at. Every run emits the full state; a Source Record
-- whose stated equals the stored one (compared as jsonb) is skipped without a write, a changed one
-- overwrites its Item in place; one that fails a check writes no Item and deletes the earlier one.
--
-- withdrawn_at: the Source no longer has it (deleted message, deleted calendar entry, unplanned
-- Lesson, or an empty Source Attribute list). Its Items are deleted (trigger below), a message's
-- row is purged, and after commit its attachments are removed from the BlobStore. Arriving
-- again clears it: a stated Source Record then writes its Item as new; a message is not read again and
-- its Items do not come back.
--
-- Retention (messages only): a message's content is deleted once none of its Items is needed any
-- more (an Event or Lesson has ended, a Task is done or past its Deadline, the Item was deleted
-- or withdrawn) or once the retention period (a constant of about 180 days) has passed since
-- occurred_at, whichever comes first. The row then becomes a tombstone: purged_at set, sender,
-- subject and body cleared, its source_record_attachment rows and their files deleted. A message row is
-- deleted once no Item points to it and it is older than the retention period. Messages whose
-- occurred_at (the Source's receive time) is older than the period are ignored on arrival.
CREATE TABLE source_record (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ,
  sender        TEXT,
  subject       TEXT,
  body          TEXT,
  stated        JSONB,
  processed_at  TIMESTAMPTZ,
  withdrawn_at  TIMESTAMPTZ,
  purged_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT source_record_external_id_unique UNIQUE (source_id, external_id),
  CONSTRAINT source_record_stated_kind_known
    CHECK (stated IS NULL OR stated->>'kind' IN ('event', 'lesson')),
  -- A stated Source Record carries nothing of a message.
  CONSTRAINT source_record_stated_is_no_message
    CHECK (stated IS NULL OR (sender IS NULL AND subject IS NULL AND body IS NULL
                              AND purged_at IS NULL AND occurred_at IS NULL)),
  -- A message has its text exactly until it is purged.
  CONSTRAINT source_record_message_has_body
    CHECK (stated IS NOT NULL OR (body IS NULL) = (purged_at IS NOT NULL)),
  CONSTRAINT source_record_message_occurred
    CHECK (stated IS NOT NULL OR occurred_at IS NOT NULL),
  CONSTRAINT source_record_purged_is_cleared
    CHECK (purged_at IS NULL OR (sender IS NULL AND subject IS NULL AND body IS NULL))
);
-- Messages waiting for extraction.
CREATE INDEX source_record_pending_idx ON source_record (occurred_at)
  WHERE processed_at IS NULL AND stated IS NULL AND withdrawn_at IS NULL AND purged_at IS NULL;
-- Retention runs over messages by age.
CREATE INDEX source_record_message_occurred_at_idx ON source_record (occurred_at)
  WHERE stated IS NULL;

-- Attachments of a message, as files behind the BlobStore. Deleted with the files on purge.
CREATE TABLE source_record_attachment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id   UUID NOT NULL REFERENCES source_record(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  blob        TEXT NOT NULL,                 -- BlobStore reference
  sha256      TEXT NOT NULL,
  size        INT NOT NULL,
  CONSTRAINT source_record_attachment_size_not_negative CHECK (size >= 0)
);
CREATE INDEX source_record_attachment_record_id_idx ON source_record_attachment (record_id);

-- The Source Attributes a Source Record carries (a mail under two allow-listed labels has two).
-- Re-emitting a Source Record with another list replaces its rows without reading it again; who its
-- Items concern follows. An empty list withdraws the Source Record. A Source Record naming an unknown or
-- archived external id is refused and warned on source_run.unknown_attributes.
-- No cascade from the attribute: archiving must not unassign Items, so deleting an attribute on
-- its own is refused. Attributes are deleted only together with their Source, whose cascade
-- also deletes these Source Records; the check is deferred so that it sees the cascade completed.
CREATE TABLE source_record_attribute (
  record_id     UUID NOT NULL REFERENCES source_record(id) ON DELETE CASCADE,
  attribute_id  UUID NOT NULL REFERENCES source_attribute(id) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (record_id, attribute_id)
);
CREATE INDEX source_record_attribute_attribute_id_idx ON source_record_attribute (attribute_id);

-- ---------------------------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------------------------

-- An Item comes from exactly one Source Record. It has no key: a message's Items are written once, and
-- a stated Source Record's one Item is found again through the Source Record. An Admin can only delete an
-- Item (DELETE FROM item); nothing remembers it. There are no corrections, no confidence and no
-- evidence. An extracted Item failing an automatic check makes the whole message be read once
-- more; failing again, it is only logged and not written.
--
-- Whom an Item concerns is computed on read from its Source Record's Source Attributes:
--   the union of their source_attribute_member rows, or the whole Family if one of them has no
--   row. Items of a Source with shown = false are left out of Agendas.
CREATE TABLE item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,
  record_id   UUID NOT NULL REFERENCES source_record(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT item_id_kind_unique UNIQUE (id, kind),  -- target of the detail tables' FKs
  CONSTRAINT item_kind_known CHECK (kind IN ('event', 'task', 'lesson'))
);
CREATE INDEX item_record_id_idx ON item (record_id);

-- One detail table per kind. (item_id, kind) references item, so a detail row always matches
-- its Item's kind; the trigger item_has_detail checks that every Item has its detail row.

-- An appointment, at a time or over whole days. No recurrence: nothing expands series.
-- A cancelled Event stays shown, struck through.
CREATE TABLE event (
  item_id    UUID PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'event',
  title      TEXT NOT NULL,
  location   TEXT,
  starts_at  TIMESTAMPTZ,
  ends_at    TIMESTAMPTZ,
  first_day  DATE,
  last_day   DATE,
  cancelled  BOOLEAN NOT NULL DEFAULT false,
  FOREIGN KEY (item_id, kind) REFERENCES item(id, kind) ON DELETE CASCADE,
  CONSTRAINT event_kind CHECK (kind = 'event'),
  CONSTRAINT event_title_length CHECK (char_length(title) <= 500),
  CONSTRAINT event_location_length CHECK (char_length(location) <= 500),
  CONSTRAINT event_one_window CHECK (
    (starts_at IS NOT NULL AND ends_at IS NOT NULL AND first_day IS NULL AND last_day IS NULL)
    OR (starts_at IS NULL AND ends_at IS NULL AND first_day IS NOT NULL AND last_day IS NOT NULL)),
  CONSTRAINT event_time_ordered CHECK (ends_at >= starts_at),
  CONSTRAINT event_days_ordered CHECK (last_day >= first_day)
);
CREATE INDEX event_starts_at_idx ON event (starts_at, ends_at);
CREATE INDEX event_first_day_idx ON event (first_day, last_day);

-- Something to do or bring. Only messages produce Tasks; its arrival is its Source Record's
-- occurred_at. deadline is the month's last day when a message names only a month.
-- bring is ticked with the Task, never entry by entry. A cancelled Task stays pinned, struck
-- through, until ticked. done_at serves "done in the last 30 days".
CREATE TABLE task (
  item_id    UUID PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'task',
  title      TEXT NOT NULL,
  deadline   DATE,
  bring      TEXT[] NOT NULL DEFAULT '{}',
  cancelled  BOOLEAN NOT NULL DEFAULT false,
  status     TEXT NOT NULL DEFAULT 'open',
  done_at    TIMESTAMPTZ,
  FOREIGN KEY (item_id, kind) REFERENCES item(id, kind) ON DELETE CASCADE,
  CONSTRAINT task_kind CHECK (kind = 'task'),
  CONSTRAINT task_title_length CHECK (char_length(title) <= 500),
  CONSTRAINT task_bring_count CHECK (cardinality(bring) <= 50),
  CONSTRAINT task_bring_length CHECK (texts_within(bring, 500)),
  CONSTRAINT task_status_known CHECK (status IN ('open', 'done')),
  CONSTRAINT task_done_at_when_done CHECK ((status = 'done') = (done_at IS NOT NULL))
);
CREATE INDEX task_status_deadline_idx ON task (status, deadline);

-- One slot of a Timetable, from WebUntis, overwritten on every poll. change is its Lesson
-- Change (NULL = as planned), with the values it replaces; a cancelled Lesson has change =
-- 'cancellation' and no separate flag. Never all day. School Days are derived, not stored.
CREATE TABLE lesson (
  item_id           UUID PRIMARY KEY,
  kind              TEXT NOT NULL DEFAULT 'lesson',
  subject           TEXT NOT NULL,
  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ NOT NULL,
  room              TEXT,
  teacher           TEXT,
  change            TEXT,
  previous_subject  TEXT,
  previous_room     TEXT,
  previous_teacher  TEXT,
  note              TEXT,
  FOREIGN KEY (item_id, kind) REFERENCES item(id, kind) ON DELETE CASCADE,
  CONSTRAINT lesson_kind CHECK (kind = 'lesson'),
  CONSTRAINT lesson_time_ordered CHECK (ends_at >= starts_at),
  CONSTRAINT lesson_change_known CHECK (change IN ('cancellation', 'substitution', 'room-change')),
  CONSTRAINT lesson_previous_only_when_changed CHECK (
    change IS NOT NULL OR (previous_subject IS NULL AND previous_room IS NULL
                           AND previous_teacher IS NULL AND note IS NULL)),
  CONSTRAINT lesson_text_length CHECK (
    char_length(subject) <= 200 AND char_length(room) <= 200 AND char_length(teacher) <= 200
    AND char_length(previous_subject) <= 200 AND char_length(previous_room) <= 200
    AND char_length(previous_teacher) <= 200 AND char_length(note) <= 200)
);
CREATE INDEX lesson_starts_at_idx ON lesson (starts_at, ends_at);

-- ---------------------------------------------------------------------------------------------
-- Agendas
-- ---------------------------------------------------------------------------------------------

-- layout fixes the kinds shown: a timeline shows Events, Lessons and Tasks; a Task List only
-- Tasks (Due and Overdue first, then not yet Due, then done in the last 30 days).
CREATE TABLE agenda (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position      BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY,
  layout        TEXT NOT NULL DEFAULT 'timeline',
  horizon_days  INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agenda_layout_known CHECK (layout IN ('timeline', 'task_list')),
  CONSTRAINT agenda_horizon_days_in_range CHECK (horizon_days BETWEEN 1 AND 31)
);

-- The Family Members an Agenda is for. No rows: the Agenda is for the whole Family and shows
-- every Item. With rows: it shows only Items concerning at least one of them, so Items concerning
-- the whole Family are not shown there. The unstored quick filter follows the same rule.
CREATE TABLE agenda_member (
  agenda_id         UUID NOT NULL REFERENCES agenda(id) ON DELETE CASCADE,
  family_member_id  UUID NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
  PRIMARY KEY (agenda_id, family_member_id)
);
CREATE INDEX agenda_member_family_member_id_idx ON agenda_member (family_member_id);

-- ---------------------------------------------------------------------------------------------
-- Triggers that keep invariants (ADR-0014, as amended by ADR-0016)
-- ---------------------------------------------------------------------------------------------

-- Deleting a Family Member:
--   - is refused while a Source Attribute is assigned to them alone, since its Items would
--     silently concern the whole Family; the Admin reassigns first. (A plain RESTRICT would
--     refuse any assignment; rows on attributes shared with others cascade.)
--   - deletes every Agenda whose only member they are, so it never silently widens to the whole
--     Family. Agendas naming others too just lose the row by cascade.
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
END $$;
CREATE TRIGGER family_member_before_delete BEFORE DELETE ON family_member
  FOR EACH ROW EXECUTE FUNCTION family_member_before_delete();

-- A withdrawn Source Record backs no Item: withdrawing it deletes its Items.
CREATE FUNCTION source_record_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM item WHERE record_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER source_record_withdrawn AFTER UPDATE OF withdrawn_at ON source_record
  FOR EACH ROW WHEN (OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL)
  EXECUTE FUNCTION source_record_withdrawn();

-- Every Item has the detail row of its kind by the end of the transaction that writes it.
CREATE FUNCTION item_has_detail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM item WHERE id = NEW.id) THEN
    RETURN NULL;                             -- deleted again in the same transaction
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
END $$;
CREATE CONSTRAINT TRIGGER item_has_detail AFTER INSERT ON item
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION item_has_detail();

-- ... and keeps it: a detail row goes only together with its Item.
CREATE FUNCTION item_detail_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM item WHERE id = OLD.item_id) THEN
    RAISE EXCEPTION 'item % lost its % row', OLD.item_id, OLD.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER event_deleted AFTER DELETE ON event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION item_detail_deleted();
CREATE CONSTRAINT TRIGGER task_deleted AFTER DELETE ON task
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION item_detail_deleted();
CREATE CONSTRAINT TRIGGER lesson_deleted AFTER DELETE ON lesson
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION item_detail_deleted();
