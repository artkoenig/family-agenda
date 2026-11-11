-- The copies of a message (ADR-0005): the Source Record itself, and, if it is a message, the
-- messages with its external id in the Sources of its Source Type, which are the same message.
CREATE FUNCTION source_record_copies(of_record UUID) RETURNS SETOF UUID
  LANGUAGE sql STABLE
  AS $$
    SELECT of_record
    UNION
    SELECT copy.id
    FROM source_record original
    JOIN source original_source ON original_source.id = original.source_id
    JOIN source copy_source ON copy_source.source_type_id = original_source.source_type_id
    JOIN source_record copy ON copy.source_id = copy_source.id AND copy.external_id = original.external_id
    WHERE original.id = of_record AND original.stated IS NULL AND copy.stated IS NULL
  $$;--> statement-breakpoint
-- A message's Items outlive a copy of it: they pass to another copy that is not withdrawn, one that
-- still has its content first. Without such a copy they stay, for the caller to delete.
CREATE FUNCTION source_record_hand_over(of_record UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  heir UUID;
BEGIN
  SELECT copy.id INTO heir
  FROM source_record copy
  WHERE copy.id IN (SELECT source_record_copies(of_record)) AND copy.id <> of_record AND copy.withdrawn_at IS NULL
  ORDER BY copy.purged_at IS NOT NULL, copy.created_at, copy.id
  LIMIT 1;
  IF heir IS NOT NULL THEN
    UPDATE item SET record_id = heir WHERE record_id = of_record;
  END IF;
END $$;--> statement-breakpoint
-- A withdrawn Source Record backs no Item: withdrawing it hands its Items to another copy of its
-- message, and deletes them if there is none.
CREATE OR REPLACE FUNCTION source_record_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM source_record_hand_over(NEW.id);
  DELETE FROM item WHERE record_id = NEW.id;
  RETURN NULL;
END $$;--> statement-breakpoint
-- Removing a Source removes its Source Records by cascade; the Items of a message another Source
-- has a copy of pass to that copy first.
CREATE FUNCTION source_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM source_record_hand_over(id) FROM source_record WHERE source_id = OLD.id AND stated IS NULL;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER source_before_delete BEFORE DELETE ON source
  FOR EACH ROW EXECUTE FUNCTION source_before_delete();
