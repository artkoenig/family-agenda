---
status: proposed
---

# Re-reading supersedes what a message stated

A message is extracted once. When the prompt or the model improves, messages read before keep what the old reading found. For example, a study day from before days off school were extracted is missing. An Admin can therefore have the messages of one Source, or of all, read again. This amends ADR-0009: Revisions are still never deleted, but a newer reading of the same Origin replaces an older one.

- **Re-reading marks messages unread.** It clears their extraction time, and the worker reads them again, a batch per tick, as it reads new ones. Until a message is read again, what it stated stays.
- **Recording a reading supersedes the Origin's Revisions.** In the transaction that records a reading, every Revision that Origin stated before is rejected as `superseded`. This includes Revisions rejected for another reason.
- **A superseded Revision counts as never stated.** Folding leaves superseded Revisions out, so the rule that a rejected first Revision removes its Item does not apply to them.
- **The same Revision comes back.** If the new reading states a Revision exactly as before, the existing row is accepted again with its old order of arrival; no duplicate is added.
- **Items keep their ids.** Item keys are positional, `<message>#<n>`, so a Revision stated again reaches the same Item, and Admins' and Views' ticks of a Task stay with it. An Item that the new reading no longer states has no accepted Revision left and disappears.
- **A thread is told only what came before.** The Items of earlier messages in the thread are shown to the model folded from what those messages and people stated. They leave out what the message itself and later messages stated, so a re-read message is not shown its own earlier result.
- **A message whose text is gone keeps what it said.** Reading it again records nothing new and supersedes nothing.

## Consequences

- Re-reading costs one LLM request per message, so it is an Admin action, not something done on every update.
- If the model has changed, an Item may move to a different position in a message. The Item at that position then takes over the old Item's ticks.
- Only Sources whose messages the LLM reads can be re-read. Calendars and timetables state their Revisions directly.

## Considered Options

- **A flag requesting a re-read, next to the extraction time**: it would keep the time of the last reading, but nothing reads that time yet, and the flag adds a second state for "waits to be read".
- **Deleting the old Revisions**: would lose why an Item looked as it did, against ADR-0009.
- **Re-reading without superseding**: Items that the old reading found by mistake would stay, and changed fields would depend on source-time ordering of identical times.
