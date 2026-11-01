---
status: superseded by ADR-0016
---

# Items are projections of append-only Revisions, applied without review

Every Source states things about Items as Revisions: one creates, changes, moves or cancels an Item. Admin corrections and ticking a Task done are Revisions too. Revisions are stored append-only. An Item's state is recomputed from its accepted Revisions, applied in the order of their source time (the mail's or WhatsApp message's send time, a calendar event's `LAST-MODIFIED`, the time Untis was polled), whenever one of them arrives, is rejected or is restored. Nothing waits for an Admin: every Revision applies at once, Agendas always show the current state, and there is no pending state and no Review Inbox. An Admin corrects after the fact, by rejecting or restoring single Revisions in a change list that can be filtered to conflicts.

We chose this because a review gate in front of every uncertain Item makes the Family's overview depend on an Admin keeping up. The earlier design had nine review triggers and a pending mark in every Agenda. Folding Revisions per Item keeps the automatic result right in most cases, and still makes every single input undoable.

## Rules

- Revisions are applied field by field, and the newest wins. A Revision from an Admin wins its fields over any Source Revision, whatever their order.
- A rejected Revision no longer counts. Rejecting an Item's first Revision removes the Item from Agendas and the ICS feed, and later Revisions that match it stay with it without bringing it back.
- A Revision is rejected automatically when its evidence quote is not found verbatim in the message, when a stated weekday doesn't match its date, or when its WhatsApp message is deleted. An Admin can restore it.
- A Revision is marked as a conflict when it was rejected automatically, when it disagrees with another Source, or when it contradicts an Admin Revision. A conflict needs no acknowledgement. The conflict filter shows only Items still on the timeline.
- A Source Assignment applies retroactively: whom an Item concerns is computed on read from the Sources of its Origins. An Item of a Source assigned to no one concerns the whole Family.
- Merging Items and splitting an Origin off reassign Revisions to Items. They are not Revisions, but they appear in the change list and can be undone.
- Extraction runs once per message. There is no second run to compare against. "Once" means one successful run: while the LLM endpoint is unreachable or rejects the key, messages wait and are retried automatically. A message that fails on its own content three times is marked Not extracted, and an Admin can retry it.

## Consequences

- Only Items are projected this way. Family Members, Sources (with their Source Assignments) and Agendas stay ordinary tables.
- A Revision arriving late, such as from the WhatsApp backfill, recomputes the Item it belongs to, so the Item never depends on arrival order.
- A Revision keeps its extracted fields when retention deletes its raw message.

## Considered Options

- **A Review Inbox that holds uncertain Items as pending until an Admin approves them**: safer per Item, but nine triggers, a pending mark in every Agenda, and an overview that degrades whenever nobody reviews.
- **Overwriting Item rows in place, with a history table next to them**: simpler to query, but rejecting one input in the middle of an Item's history would need hand-written undo logic for every kind of change.

_Superseded by ADR-0016: there are no Revisions. Each Item is a row written from its one Source Record. A message's Items are written once, and a calendar entry's or Lesson's Item is overwritten. Admins can only delete Items, and there is no reject, restore or conflict list._
