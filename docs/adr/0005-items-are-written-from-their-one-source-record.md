---
status: accepted
---

# Items are rows written from their one Source Record, without Revisions

Items were projections of append-only Revisions, with Re-reading superseding what a message stated. That design paid for undoing any single input with folding, rejection, restoring, conflict marks, positional Item keys and a thread-aware prompt, while nothing in the Family's daily use needed it. We rebuild the data model from scratch instead. Every Item is an ordinary row that comes from exactly one Source Record. A message's Items are written once. A calendar entry's or Lesson's one Item is overwritten when the entry changes. The target schema is [`docs/schema.sql`](../schema.sql). There is no data migration: existing Instances start over.

## Source Records and Source Attributes

- **A Source Record** (`source_record`) is what a Source delivered under one external id. It is either a message (mail, Messenger message), with its text in `sender`/`subject`/`body` and only its attachments behind the BlobStore (ADR-0003), or a stated Source Record, which holds the Item as an ICS or WebUntis plugin states it in `stated JSONB`, with no file. A CHECK keeps the two apart.
- **Source Attributes replace Parts.** A Source Attribute is a subdivision of a Source that the plugin reports through a port: `attributes.declare([{ externalId, name }])` inserts the attribute, or renames and revives a known one keeping its assignment, and `attributes.archive(externalId)` archives it. Nothing is synced by diff, and the core never creates one. A Source without subdivisions declares exactly one. For v1, these are IMAP folders or Gmail labels, WhatsApp groups by their JID, one constant attribute per ICS calendar, and one per child of a WebUntis account, so one Source per account. The `parts: true` configuration field goes away.
- **Allow-lists stay a pre-filter.** The `folders` and `chats` an Admin selects in a Source's configuration are all that is read. The plugin declares only those, names only those on a Source Record, and drops everything else itself. The list it offers to choose from is a plugin query, not stored. There is no `read` flag and no `rename`. A renamed Gmail label, or an IMAP folder without `OBJECTID`, looks like archive plus declare, and the Admin reassigns it while fixing the allow-list.
- **A Source Record names all its Source Attributes** (`source_record_attribute`). Emitting it again with another list replaces them without reading it again. An empty list withdraws it. Naming an unknown or archived external id is a plugin bug: the Source Record is refused, and a warning appears beside the Source Status. `receive` (push) gets the same port, and declares take effect before the Source Records that follow them.
- **In the plugin contract, `attributes` means only Source Attribute ids.** The free-form display bag goes, in favour of the explicit Source Record fields.

## Assignment and whom an Item concerns

Family Members are assigned only to Source Attributes (`source_attribute_member`). An Item concerns everyone its Source Record's Source Attributes are assigned to, or the whole Family if one of them is assigned to no one. This is computed on read, so a changed assignment applies to past Items too. Archiving a Source Attribute keeps its assignment. Deleting a Family Member is refused while a Source Attribute is assigned to them alone, so its Items cannot silently start to concern the whole Family.

## Items

- **Three kinds:** Event, Task and Lesson, stored as a base `item` table plus one detail table per kind. Notice is dropped. A Timetable Change is no longer an Item: it is the change on a Lesson (`change`, with the subject, room and teacher it replaces). Events do not recur. School Days stay derived from Lessons.
- **No key, no merging.** An Item has its Source Record's id (`item.record_id NOT NULL`) and nothing else that identifies it. Items are never merged across messages or Sources, and a later message never changes, moves or cancels an Item an earlier one created. The same message in several Sources is read once (see Amendments).
- **Messages are read once.** A successful reading writes the message's Items and sets `processed_at`. Nothing reads the message again: an edited message keeps its first reading. An Admin can retry a message whose extraction keeps failing, which has no Items yet.
- **Automatic checks replace rejection.** When an extracted Item fails a check (evidence not found verbatim, a weekday not matching its date, no resolvable date), the whole message is read once more and the second reading counts. An Item that fails again is written to the application log and not to the database. Evidence is checked during extraction and then discarded. There is no confidence and no other uncertainty flag: an Item is either written and trusted, or not written.
- **Stated Source Records are written without the LLM.** ICS (when its ETag changed) and WebUntis (its 14-day window) emit their full state on every run. A `stated` equal to the stored one (compared as `jsonb`, whatever the order of its keys) is skipped without a write. A changed one overwrites its Item in place; a stated Task is overwritten in its title, Deadline and things to bring only, because whether it is done is the Family's to say by ticking it (see Amendments). One stating another kind of Item replaces it. An entry that vanishes is withdrawn, not cancelled. `event.cancelled` is set only for `STATUS:CANCELLED`, and a Lesson's change comes from the Untis flags. A stated Item failing a check, the domain's or the schema's, is stored as a Source Record but writes no Item, and deletes the Item an earlier valid version wrote, since the Source no longer states it. It is logged and its external id is listed in `source_run.invalid_records`, shown as a warning beside the Source Status, until it writes its Item or is withdrawn. It is not read again.
- **Admins can only delete an Item.** Nothing remembers the deletion, and there are no field corrections, no reject or restore, no conflict list and no `dismissed` status. A Task's status is `open` or `done`.
- **Withdrawal deletes the Source Record's Items.** A withdrawn Source Record keeps its row. If it arrives again, `withdrawn_at` is cleared. A stated Source Record then writes its Item as new. A message is not read again, so its Items do not come back.

## Retention

A message's content (its text and attachments) is deleted once no Item needs it (an Event or Lesson has ended, a Task is done or past its Deadline, the Item was deleted or withdrawn) or once a constant retention period of about 180 days has passed since it arrived, whichever comes first. The Source Record then stays as a tombstone (`purged_at`, with its content cleared), which the Admin area shows as "content no longer kept". The row is deleted once no Item points to it and it is older than the period. Messages older than the period are ignored on arrival, so a Source redelivering them (an IMAP `UIDVALIDITY` reset, a Matrix backfill) cannot bring them back. Stated Source Records have no content of a message and are not subject to retention.

## Files and secrets

Postgres refers to files in the BlobStore and to secrets in the SecretStore without foreign keys (ADR-0003). So a cascade, a crash or a forgotten call can leave a file or a secret that nothing refers to any more. Both are removed in two ways.

- **Directly, after the commit.** A transaction that stops referring to files or secrets returns their references, and the caller removes them once it has committed. This covers removing a Source, a withdrawn or purged message, a replaced photo or secret, and a run's new files when the message was already known. A cascade drops the references with the rows, so the repository reads them before it deletes.
- **By a sweep, as the safety net.** When the worker starts, and once a day after that, it removes every file and every secret that nothing refers to and that is older than an hour. A younger one may belong to a transaction still running. Files are referred to by `source_record_attachment.blob` and `family_member.photo_blob`, and secrets by `source.secret_refs` and `llm_endpoint.api_key_ref`. The BlobStore gains a `list()`, as the SecretStore already has.

The sweep is what makes this correct. A missed direct removal costs only disk space until the next sweep, and never leaves a row pointing at nothing.

## Agendas

An Agenda filters only on Family Members (`agenda_member`). Its `layout` (`timeline` or `task_list`) fixes the kinds it shows, and `horizon_days` how far ahead it reaches. An Agenda with no members shows every Item. One with members shows only the Items that concern at least one of them, so Items that concern the whole Family are not shown there. This reverses the earlier behaviour. The unstored Quick Filter follows the same rule. Deleting a Family Member deletes the Agendas left with no member, so none silently widens to the whole Family.

## Migrations

The migration history is squashed into one initial migration, `packages/adapters/drizzle/0000_initial.sql`: the tables drizzle-kit generates from `schema.ts`, plus the helper function, the triggers and the one `family` row that it cannot express. [`docs/schema.sql`](../schema.sql) stays the readable reference, and a test applies the migration to an empty database and fails on any difference from it. Later schema changes are new migrations, and the document changes with them.

An Instance whose database was created before the rebuild is detected by the hash of its first applied migration and refused at start with a message telling the Admin to start over, instead of failing on a half-applied schema. The release notes (`RELEASE_NOTES.md`) say what to note down first and which volumes to remove. The Recovery Kit stays valid for the Source credentials entered afterwards only if the master key is kept.

Where the first drafts of the schema document and the code differed, the implementation settled it: a Source Record has an optional `link` to the original; attachments have a `position` and a `conversion_problem`; a Source's `name` may be empty, and the Admin area then derives one; and an Agenda's `layout` replaces its `kind`.

## Amendments

### Copies of a message

A mail to a mailing list arrives in the mailbox of every Family Member on the list. Each mailbox is a Source, so the mail became one Source Record per mailbox, each was read, and its Items appeared once per mailbox. Messages with the same external id in Sources of the same Source Type are now Copies of one message, and only the first is read.

- **What makes two Source Records Copies.** Both are messages, their Sources have the same Source Type, and their external ids are equal as strings. Stated Source Records are never Copies, and nothing is compared across Source Types. A plugin therefore gives a message the same external id in every Source of its Source Type that receives it, and different messages different ones; the IMAP plugin uses the `Message-ID` header. Within one Source this was always so.
- **Only the first Copy is read.** A message arriving when another Source has a Copy that is read, or waits to be, is recorded as its own Source Record and marked as read at once. It writes no Items, so it does not bring back an Item an Admin deleted either. A Copy that is Withdrawn, or came back after it was, does not count: a message arriving then is read.
- **A later Copy gives its Source Attributes to the first.** They are added to the Source Record that has the Items (`source_record_attribute`, which may name Source Attributes of another Source for this), so whom the Items concern is computed as for any Item, and they concern everyone either Copy concerns. They follow the later Copy when it moves to other Source Attributes, and are taken back when it is Withdrawn or its Source is removed.
- **A Copy is read in place of one withdrawn unread.** When the first Copy is Withdrawn while it still waits to be read, the next Copy that has its text waits in its place, and the others give it their Source Attributes.
- **The Items stay with the first Copy.** Everything else is as for any message: they name that Source Record and its Source alone, are shown or hidden with that Source, and are deleted when it is Withdrawn or its Source is removed, even if another Source still has a Copy, which is not read in its place.

Two runs recording Copies of one message at the same moment, such as a run an Admin starts beside the worker's, do not see each other's, and both are read. This is accepted: it takes two Sources polled within the same instant.

This does not merge Items of different messages, which stays rejected below: a forwarded mail has another external id and is read on its own. A plugin whose external ids are not the same message across its Sources, such as a position in a mailbox for a mail without `Message-ID`, can make two different messages look like Copies, and the second is then not read; such ids have to differ per Source.

## Consequences

- An improved prompt or model applies only to new messages. Earlier messages keep what they stated.
- An appointment deleted from a calendar, rather than cancelled, vanishes from Agendas silently.
- Whole-Family Items no longer appear on an Agenda for chosen Family Members. A Family that wants them there assigns the Source Attribute to those members.
- A message's content is gone after the retention period. A message whose extraction failed can no longer be retried after that.
- Renaming a Gmail label loses its assignment until an Admin reassigns it.
- The Items of a message in several mailboxes go when the mailbox it was read from deletes it, though another still has it.

## Considered Options

- **Keep Revisions**: every single input stays undoable, but folding, rejection, restoring and conflicts dominate the model and the code for corrections Admins hardly make. Without them an Admin's only remedy is deleting an Item.
- **Keep Re-reading** with a positional, LLM-chosen or content-derived key to carry ticks over: an improved prompt would reach old messages, but every key moves when the model splits a message differently, and a tick would land on the wrong Item. Matching by content has the same problem.
- **Merging Items** across messages or Sources, or letting a later message change or cancel an earlier one's Item: fewer duplicates, but whom a merged Item concerns, and which Source Record wins a field, bring back what Revisions were for.
- **Keeping a message's raw file** (`raw_blob`) beside its text: plugins hand over the text they parsed, not the MIME mail or the Matrix event, so the file held the same text as `body` again. The original stays with the mailbox or homeserver, and a message is read only once, so nothing would re-parse it. Without it, only attachments are files.
- **Keeping confidence** as a cut-off or showing it: the LLM's confidence in itself is weakly calibrated (`docs/research/llm-item-extraction.md`). As a cut-off it would drop correct Items without a way back, and on the Agenda it adds noise.
- **Recurring Events**, from `RRULE`s or recurring rules in messages: needs expanding series and exceptions, and is not needed for this redesign.
- **Admins creating or correcting Items by hand**: an Item without a Source Record would have no Source Attribute to say whom it concerns. A correction would have to survive overwriting, which is the override table this design avoids.
- **A `read` flag on Source Attributes instead of the allow-lists**, or a `rename` in the port: the plugin would declare Sent, Trash and private chats only to have them ignored. A name-keyed rename cannot be told from delete plus create anyway.
- **An outbox of dropped file references**, filled by triggers on the rows that refer to files: catches cascades without a scan, but not a file written for a transaction that never commits. That still needs the sweep, which alone covers every case.
- **An Agenda filter as JSONB**, or on Sources, Source Attributes or kinds: JSONB has no foreign keys, and assigning Source Attributes already turns where an Item came from into whom it concerns.
