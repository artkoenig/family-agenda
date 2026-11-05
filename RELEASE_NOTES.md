# Release notes

## The data model is rebuilt: existing Instances start over

This release replaces the data model (ADR-0016). **There is no data migration.** The migration history is squashed into one initial migration, and an Instance whose database was created by an earlier version refuses to start, with a message that says so, instead of failing on a half-applied schema. Items, Agendas, Sources, Family Members and the Admin account have to be set up again.

### What changes for the Family

- Items are plain rows written once from their one message or calendar entry. There are no Revisions, no Re-reading and no Notices; a Timetable Change is shown on the Lesson it changes.
- Family Members are assigned to a Source's Source Attributes (an IMAP folder or Gmail label, a WhatsApp group, a WebUntis child) instead of to a Source's Parts. A WebUntis account is one Source with one Source Attribute per child.
- An Agenda shows a Family Member's Items only if it is for that member (`agenda_member`). Items that concern the whole Family are no longer shown on an Agenda for chosen Family Members; assign the Source Attribute to those members to see them there.
- A message's text and attachments are deleted after about 180 days, or once no Item needs them.

### Before you upgrade

Nothing in the old database is carried over, so note down what you need to enter again:

1. **Sources**: the host, folders or labels, ICS URLs and WebUntis QR codes or logins of each Source, and who each is assigned to. Credentials are stored encrypted in the database, which is emptied, so they cannot be read afterwards.
2. **Family Members and Agendas**: names and photos, and which Family Members each Agenda is for.
3. **Messengers**: the Matrix profile's data (Synapse and the bridges) is emptied too, so every linked WhatsApp account has to be linked again.
4. **The Recovery Kit and the master key**. The Recovery Kit stays valid for the Source credentials you enter on the new Instance **only if you keep the master key**, that is the `master-key` volume. If you remove it, the first start creates a new master key and a new Recovery Kit, and the old kit opens nothing. Backups taken before the upgrade cannot be restored on this version either way.

### Starting over

Stop the Instance, remove the volumes that hold data of the old model, and start it again. The `master-key`, `plugins` and `tessdata` volumes can stay.

```bash
docker compose down
docker volume rm family-agenda_postgres-data family-agenda_blobs family-agenda_matrix-data family-agenda_matrix-instance
docker compose up -d --build
```

Then open the Instance, create the first Admin, keep the Recovery Kit it shows, and add Family Members, Agendas and Sources again.
