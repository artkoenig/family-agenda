ALTER TABLE "agenda_preselection" RENAME TO "agenda_member";--> statement-breakpoint
ALTER TABLE "agenda_member" DROP CONSTRAINT "agenda_preselection_agenda_id_agenda_id_fk";
--> statement-breakpoint
ALTER TABLE "agenda_member" DROP CONSTRAINT "agenda_preselection_family_member_id_family_member_id_fk";
--> statement-breakpoint
DROP INDEX "agenda_preselection_family_member_id_idx";--> statement-breakpoint
ALTER TABLE "agenda_member" DROP CONSTRAINT "agenda_preselection_agenda_id_family_member_id_pk";--> statement-breakpoint
ALTER TABLE "agenda_member" ADD CONSTRAINT "agenda_member_agenda_id_family_member_id_pk" PRIMARY KEY("agenda_id","family_member_id");--> statement-breakpoint
ALTER TABLE "agenda_member" ADD CONSTRAINT "agenda_member_agenda_id_agenda_id_fk" FOREIGN KEY ("agenda_id") REFERENCES "public"."agenda"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_member" ADD CONSTRAINT "agenda_member_family_member_id_family_member_id_fk" FOREIGN KEY ("family_member_id") REFERENCES "public"."family_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agenda_member_family_member_id_idx" ON "agenda_member" USING btree ("family_member_id");--> statement-breakpoint
-- Deleting a Family Member (ADR-0016): refused while a Source Attribute is assigned to them alone,
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
