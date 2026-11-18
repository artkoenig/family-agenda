// The lifecycle of a Source's Source Records (ADR-0005): delivered by a run, delivered again, read
// once, withdrawn and arriving again, an Admin deleting an Item, and retention purging a message's
// content to a tombstone and deleting its row, while the Source redelivers old messages (an IMAP
// UIDVALIDITY reset, a Matrix backfill).
//
// One Source: its runs take turns (ADR-0008, specs/source-turn), so they never overlap, but each
// run's plugin call may last while the extraction, the purge and an Admin act. Each action is one
// transaction of the core. Time is a counter the clocks follow. Each message yields at most one
// Item; each calendar entry states one.
//
// Left out: Copies of a message across Sources (their only race, two runs recording Copies at
// once, ADR-0005 accepts); invalid stated Items and `source_run.invalid_records`; Source
// Attributes and whom an Item concerns; Tasks being ticked (an Item is needed until it ends); the
// files behind the BlobStore (the sweep's spec); a stated Item changing kind. The recording's
// clock is read just before its transaction, which the model folds into `record`: a purge
// committing between the two, as a redelivered message passes its retention in that instant, is
// not modelled.
//
// Actions and the code they stand for (application: polling.ts, extraction, retention.ts;
// adapters: PostgresItemRepository):
//   arrive, vanish, restate  the Source's own world: a message arrives or is deleted (and moved back),
//                            a calendar entry changes or is removed
//   call                     runNow: the clock read once as the run's `at`, then the plugin's call,
//                            whose answer is fixed here: any of the Source's messages (redelivered or
//                            not), withdrawals of what it no longer has, and every entry's state
//   record                   ItemRepository.recordRun: recordMessage, recordStated (keptUnchanged,
//                            writeStated), withdraw and its trigger deleting the Items
//   pick, extract            extractPending: pendingMessages, the LLM's reading, recordExtraction
//   purge                    Retention.purge: ItemRepository.purgeMessages
//   deleteItem               an Admin deleting an Item
module sourceRecords {
  // ---- Parameters -----------------------------------------------------------------------------

  /** External ids of the Source's messages. */
  const MESSAGES: Set[str]
  /** External ids of the Source's calendar entries (stated Source Records). */
  const ENTRIES: Set[str]
  /** What an entry may state; 0 is reserved for "the Source no longer has it". */
  const STATES: Set[int]
  /** The retention period, in ticks. */
  const RETENTION: int
  /** Bounds the clock, so that the state space is finite. */
  const MAX_TIME: int
  /**
   * Whether a run decides which messages are past retention by the clock at its recording, as the
   * purge's delete does. False is the code as it was before this spec: by the run's `at`, read before
   * the plugin's call, so that a purge during the call can delete a row the run then inserts anew.
   */
  const CUTOFF_AT_RECORDING: bool

  // ---- State ----------------------------------------------------------------------------------

  /**
   * A row of `source_record`; `exists` false means no row. `stated` 0 is a message. `content` is its
   * text and attachments (body not null), `processed` processed_at, `withdrawn` withdrawn_at,
   * `purged` purged_at.
   */
  type SourceRecord = {
    exists: bool,
    stated: int,
    occurredAt: int,
    content: bool,
    processed: bool,
    withdrawn: bool,
    purged: bool,
  }

  /** A Source Record's one Item; `present` false means none. Needed while `endsAt` has not passed. */
  type Item = { present: bool, endsAt: int, value: int }

  /** A message as the Source has it. */
  type Held = { present: bool, occurredAt: int }

  /**
   * A run between its plugin's call and its recording: its `at`, the messages the plugin delivered,
   * those it reported withdrawn, and what every entry states (0: none).
   */
  type Run = { active: bool, at: int, delivered: Set[str], withdrawn: Set[str], stated: str -> int }

  /** The extraction between reading a pending message and recording what the LLM read. */
  type Reading = { active: bool, id: str, row: int }

  /** The action that fired last, for the witnesses. */
  type Did =
    | DidInit | DidTick | DidArrive | DidVanish | DidRestate | DidCall | DidRecord | DidPick | DidExtract
    | DidPurge | DidDeleteItem

  /**
   * Ghost state, not in the database: which action fired last; how many rows each external id made;
   * how often each message was read; whether a stated Source Record equal to the stored one wrote;
   * whether the purge removed content an Item still needed, or a row an Item pointed to; whether a
   * message's row was made again after retention deleted it, or made already past retention.
   */
  type Ghost = {
    lastAction: Did,
    rowsMade: str -> int,
    reads: str -> int,
    wroteUnchanged: bool,
    purgedNeeded: bool,
    deletedWithItem: bool,
    cameBack: bool,
    deleted: Set[str],
  }

  var now: int
  var records: str -> SourceRecord
  var items: str -> Item
  var source: str -> Held
  var entries: str -> int
  var calling: Run
  var reading: Reading
  var ghost: Ghost

  // ---- Functional logic -----------------------------------------------------------------------

  val IDS: Set[str] = MESSAGES.union(ENTRIES)
  val noRecord: SourceRecord = { exists: false, stated: 0, occurredAt: 0, content: false, processed: false, withdrawn: false, purged: false }
  val noItem: Item = { present: false, endsAt: 0, value: 0 }
  val noRun: Run = { active: false, at: 0, delivered: Set(), withdrawn: Set(), stated: ENTRIES.mapBy(_ => 0) }

  pure def isMessage(r: SourceRecord): bool = r.exists and r.stated == 0

  /** retainedSince: before this, a message is past retention. */
  pure def retainedSince(at: int, period: int): int = at - period

  /** pendingMessage: a message with its text, not yet read and not withdrawn. */
  pure def pending(r: SourceRecord): bool = isMessage(r) and r.content and not(r.processed) and not(r.withdrawn)

  /** neededAt: an Item that has not ended. */
  pure def needed(i: Item, at: int): bool = i.present and i.endsAt >= at

  /** recordMessage: inserts a new message, or only clears withdrawn_at of a known one. */
  pure def recordMessage(r: SourceRecord, occurredAt: int): SourceRecord =
    if (r.exists) { ...r, withdrawn: false }
    else { exists: true, stated: 0, occurredAt: occurredAt, content: true, processed: false, withdrawn: false, purged: false }

  /** keptUnchanged: an entry stating what it stated before, and not withdrawn. */
  pure def keptUnchanged(r: SourceRecord, value: int): bool = r.exists and r.stated == value and not(r.withdrawn)

  /**
   * withdraw: a message loses its content and counts as not read; an entry keeps processed_at.
   * The trigger deletes the Items.
   */
  pure def withdraw(r: SourceRecord): SourceRecord =
    if (not(r.exists) or r.withdrawn) r
    else if (r.stated == 0) { ...r, withdrawn: true, purged: true, content: false, processed: false }
    else { ...r, withdrawn: true }

  /** purgeMessages, first statement: past retention, or read and with no Item that still needs it. */
  pure def purgesContent(r: SourceRecord, i: Item, at: int, period: int): bool =
    isMessage(r) and not(r.purged) and (r.occurredAt < retainedSince(at, period) or (r.processed and not(needed(i, at))))

  /** purgeMessages, last statement: a message past retention to which no Item points. */
  pure def deletesRow(r: SourceRecord, i: Item, at: int, period: int): bool =
    isMessage(r) and r.occurredAt < retainedSince(at, period) and not(i.present)

  // ---- State machine --------------------------------------------------------------------------

  action did(name: Did): bool = ghost' = { ...ghost, lastAction: name }

  action keepWorld: bool = all { source' = source, entries' = entries }
  action keepDb: bool = all { records' = records, items' = items }

  action init = all {
    now' = 0,
    records' = IDS.mapBy(_ => noRecord),
    items' = IDS.mapBy(_ => noItem),
    source' = MESSAGES.mapBy(_ => { present: false, occurredAt: 0 }),
    entries' = ENTRIES.mapBy(_ => 0),
    calling' = noRun,
    reading' = { active: false, id: "", row: 0 },
    ghost' = {
      lastAction: DidInit, rowsMade: IDS.mapBy(_ => 0), reads: IDS.mapBy(_ => 0), wroteUnchanged: false,
      purgedNeeded: false, deletedWithItem: false, cameBack: false, deleted: Set(),
    },
  }

  action tick = all {
    now < MAX_TIME, now' = now + 1,
    keepWorld, keepDb, calling' = calling, reading' = reading, did(DidTick),
  }

  /** A message the Source receives now, once. */
  action arrive(m: str): bool = all {
    not(source.get(m).present), source.get(m).occurredAt == 0, ghost.rowsMade.get(m) == 0,
    source' = source.set(m, { present: true, occurredAt: now + 1 }),
    entries' = entries, now' = now, keepDb, calling' = calling, reading' = reading, did(DidArrive),
  }

  /** A message deleted from the Source, or moved back into it. `occurredAt` stays what the Source received. */
  action vanish(m: str): bool = all {
    source.get(m).occurredAt > 0,
    source' = source.set(m, { ...source.get(m), present: not(source.get(m).present) }),
    entries' = entries, now' = now, keepDb, calling' = calling, reading' = reading, did(DidVanish),
  }

  /** A calendar entry that appears, changes or is removed (0). */
  action restate(e: str, value: int): bool = all {
    entries.get(e) != value,
    entries' = entries.set(e, value),
    source' = source, now' = now, keepDb, calling' = calling, reading' = reading, did(DidRestate),
  }

  /**
   * A run reads the clock and calls the plugin, which delivers any of the Source's messages (a
   * UIDVALIDITY reset or a backfill delivers old ones again), reports any it no longer has as
   * withdrawn, and states every entry, an entry it no longer has as withdrawn.
   */
  action call(delivered: Set[str], withdrawn: Set[str]): bool = all {
    not(calling.active),
    delivered.forall(m => source.get(m).present),
    withdrawn.forall(m => not(source.get(m).present)),
    calling' = { active: true, at: now, delivered: delivered, withdrawn: withdrawn, stated: entries },
    now' = now, keepWorld, keepDb, reading' = reading, did(DidCall),
  }

  /** recordRun: the run's messages, entries and withdrawals, in one transaction. */
  action record: bool = {
    val cutoff = retainedSince(if (CUTOFF_AT_RECORDING) now else calling.at, RETENTION)
    // A message past retention is ignored.
    val recorded = calling.delivered.filter(m => not(source.get(m).occurredAt < cutoff))
    val gone = calling.withdrawn.union(ENTRIES.filter(e => calling.stated.get(e) == 0))
    val written = ENTRIES.filter(e => calling.stated.get(e) != 0 and not(keptUnchanged(records.get(e), calling.stated.get(e))))
    val made = recorded.filter(m => not(records.get(m).exists))
    val nextRecords = IDS.mapBy(id =>
      if (recorded.contains(id)) recordMessage(records.get(id), source.get(id).occurredAt)
      else if (written.contains(id)) { ...noRecord, exists: true, stated: calling.stated.get(id), processed: true }
      else if (gone.contains(id)) withdraw(records.get(id))
      else records.get(id))
    val nextItems = IDS.mapBy(id =>
      if (written.contains(id)) { present: true, endsAt: MAX_TIME, value: calling.stated.get(id) }
      else if (gone.contains(id) and records.get(id).exists and not(records.get(id).withdrawn)) noItem
      else items.get(id))
    all {
      calling.active,
      records' = nextRecords,
      items' = nextItems,
      calling' = noRun,
      now' = now, keepWorld, reading' = reading,
      ghost' = {
        ...ghost,
        lastAction: DidRecord,
        rowsMade: IDS.mapBy(id => ghost.rowsMade.get(id) + (if (made.contains(id) or (written.contains(id) and not(records.get(id).exists))) 1 else 0)),
        wroteUnchanged: ghost.wroteUnchanged or ENTRIES.exists(e =>
          calling.stated.get(e) != 0 and keptUnchanged(records.get(e), calling.stated.get(e)) and nextItems.get(e) != items.get(e)),
        cameBack: ghost.cameBack or made.exists(m => ghost.deleted.contains(m) or source.get(m).occurredAt < retainedSince(now, RETENTION)),
      },
    }
  }

  /** pendingMessages: the extraction reads a message waiting to be read. */
  action pick(m: str): bool = all {
    not(reading.active), pending(records.get(m)),
    reading' = { active: true, id: m, row: ghost.rowsMade.get(m) },
    now' = now, keepWorld, keepDb, calling' = calling, did(DidPick),
  }

  /**
   * recordExtraction: the message is marked read with its Item, if any, unless it no longer waits
   * (withdrawn or purged meanwhile).
   */
  action extract(yields: bool, endsAt: int): bool = {
    val m = reading.id
    // By the row's id: a row made again is another Source Record.
    val stillPending = pending(records.get(m)) and ghost.rowsMade.get(m) == reading.row
    all {
      reading.active,
      reading' = { active: false, id: "", row: 0 },
      records' = if (stillPending) records.set(m, { ...records.get(m), processed: true }) else records,
      items' = if (stillPending and yields) items.set(m, { present: true, endsAt: endsAt, value: 0 }) else items,
      now' = now, keepWorld, calling' = calling,
      ghost' = { ...ghost, lastAction: DidExtract, reads: ghost.reads.set(m, ghost.reads.get(m) + (if (stillPending) 1 else 0)) },
    }
  }

  /** purgeMessages: purges content, then deletes the rows past retention that no Item points to. */
  action purge: bool = {
    val purged = MESSAGES.filter(m => purgesContent(records.get(m), items.get(m), now, RETENTION))
    val afterPurge = records.keys().mapBy(id =>
      if (purged.contains(id)) { ...records.get(id), purged: true, content: false } else records.get(id))
    val deleted = MESSAGES.filter(m => deletesRow(afterPurge.get(m), items.get(m), now, RETENTION))
    all {
      purged.union(deleted) != Set(),
      records' = afterPurge.keys().mapBy(id => if (deleted.contains(id)) noRecord else afterPurge.get(id)),
      items' = items,
      now' = now, keepWorld, calling' = calling, reading' = reading,
      ghost' = {
        ...ghost,
        lastAction: DidPurge,
        // Within the period, content goes only once read and no Item needs it.
        purgedNeeded: ghost.purgedNeeded or purged.exists(m =>
          not(records.get(m).occurredAt < retainedSince(now, RETENTION))
            and (not(records.get(m).processed) or needed(items.get(m), now))),
        deletedWithItem: ghost.deletedWithItem or deleted.exists(m => items.get(m).present),
        deleted: ghost.deleted.union(deleted),
      },
    }
  }

  /** An Admin deletes an Item. Nothing remembers it. */
  action deleteItem(id: str): bool = all {
    items.get(id).present,
    items' = items.set(id, noItem),
    records' = records, now' = now, keepWorld, calling' = calling, reading' = reading, did(DidDeleteItem),
  }

  action step = any {
    tick,
    nondet m = MESSAGES.oneOf()
    any { arrive(m), vanish(m), pick(m) },
    nondet e = ENTRIES.oneOf()
    nondet value = STATES.union(Set(0)).oneOf()
    restate(e, value),
    nondet delivered = MESSAGES.powerset().oneOf()
    nondet withdrawn = MESSAGES.powerset().oneOf()
    call(delivered, withdrawn),
    record,
    nondet yields = Set(true, false).oneOf()
    nondet endsAt = now.to(now + RETENTION).oneOf()
    extract(yields, endsAt),
    purge,
    nondet id = IDS.oneOf()
    deleteItem(id),
  }

  // ---- Properties -----------------------------------------------------------------------------

  /** One external id never makes two Source Records. */
  val oneRecordPerExternalId: bool = IDS.forall(id => ghost.rowsMade.get(id) <= 1)
  /** A message is read once. */
  val readOnce: bool = MESSAGES.forall(m => ghost.reads.get(m) <= 1)
  /** A withdrawn Source Record has no Items. */
  val withdrawnHasNoItems: bool = IDS.forall(id => records.get(id).withdrawn implies not(items.get(id).present))
  /** A row with an Item exists: an Item always has its Source Record. */
  val itemHasRecord: bool = IDS.forall(id => items.get(id).present implies records.get(id).exists)
  /** A stated equal to the stored one writes nothing. */
  val unchangedWritesNothing: bool = not(ghost.wroteUnchanged)
  /** Retention never deletes content an Item still needs, nor a row an Item points to. */
  val retentionKeepsNeeded: bool = not(ghost.purgedNeeded) and not(ghost.deletedWithItem)
  /** A message older than the retention period never comes back. */
  val oldNeverComesBack: bool = not(ghost.cameBack)

  val safety: bool = and {
    oneRecordPerExternalId, readOnce, withdrawnHasNoItems, itemHasRecord, unchangedWritesNothing,
    retentionKeepsNeeded, oldNeverComesBack,
  }

  /**
   * What keeps liveness possible. A message past retention still with content is purged by the next
   * purge (it is enabled); a withdrawn entry the Source states again writes its Item at the next
   * recording. The scenarios show both happening.
   */
  val pastRetentionIsPurgeable: bool = MESSAGES.forall(m =>
    (isMessage(records.get(m)) and records.get(m).content and records.get(m).occurredAt < retainedSince(now, RETENTION))
      implies purgesContent(records.get(m), items.get(m), now, RETENTION))

  // ---- Witnesses ------------------------------------------------------------------------------

  val readWithItem: bool = MESSAGES.exists(m => records.get(m).processed and items.get(m).present)
  val tombstone: bool = MESSAGES.exists(m => records.get(m).purged and not(records.get(m).withdrawn))
  val rowDeleted: bool = ghost.deleted != Set()
  val withdrawnMessage: bool = MESSAGES.exists(m => records.get(m).withdrawn)
  val messageBack: bool = MESSAGES.exists(m => records.get(m).exists and records.get(m).purged and not(records.get(m).withdrawn) and ghost.lastAction == DidRecord)
  val entryWithdrawn: bool = ENTRIES.exists(e => records.get(e).withdrawn)
  val itemDeleted: bool = ghost.lastAction == DidDeleteItem
}
