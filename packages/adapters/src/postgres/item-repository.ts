import type {
  Extraction,
  InvalidRecord,
  ItemDetails,
  ItemRepository,
  NewItem,
  PendingMessage,
  ProjectedItem,
  RawMessage,
  ReadStated,
  RunRecorded,
  SourceRun,
  StatedItem,
  StoredMessage,
} from "@family-agenda/application";
import type { BlobRef, Event, FamilyMemberId, ItemId, StatedTask, LocalDate, RawMessageId, SourceId, SourceTypeId, TimeSpan, TimetableChangeKind } from "@family-agenda/domain";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { uuidPattern } from "../uuid";
import type { Database } from "./database";
import { cursorToJson, failureColumns } from "./repositories";
import {
  events,
  familyMembers,
  items,
  lessons,
  sourceAttributeMembers,
  sourceAttributes,
  sourceRecordAttachments,
  sourceRecordAttributes,
  sourceRecords,
  sourceRuns,
  sources,
  tasks,
} from "./schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type RunOrigin = SourceRun["origins"][number];

/** What recording a run's stated Source Records found: which wrote their Item, and which were invalid. */
type StatedOutcome = { written: string[]; invalid: InvalidRecord[] };

/** The Source Attributes of a Source by external id, as `recordRun` resolves what Origins name. */
type KnownAttributes = Map<string, { id: string; archived: boolean }>;

/** A message, with its text, waiting for its one successful extraction. */
const pendingMessage = and(isNull(sourceRecords.processedAt), isNotNull(sourceRecords.body), isNull(sourceRecords.withdrawnAt));

/** The Source Records that are the same message as this one, itself among them (ADR-0005). */
const copiesOf = (recordId: SQLWrapper) => sql`(SELECT source_record_copies(${recordId}))`;

/**
 * Whether another copy of the message, which waits to be read too, comes before this one: of the
 * copies that wait, only the first is read.
 */
const waitsBehindCopy = sql`EXISTS (
  SELECT 1 FROM source_record AS earlier
  WHERE earlier.id IN ${copiesOf(sourceRecords.id)}
    AND earlier.processed_at IS NULL AND earlier.body IS NOT NULL AND earlier.withdrawn_at IS NULL
    AND (earlier.created_at, earlier.id) < (${sourceRecords.createdAt}, ${sourceRecords.id})
)`;

/** Whether another copy of the message has been read, and its Source still has it. */
const readAsCopy = (recordId: SQLWrapper) => sql`EXISTS (
  SELECT 1 FROM source_record AS read
  WHERE read.id IN ${copiesOf(recordId)} AND read.id <> ${recordId}
    AND read.processed_at IS NOT NULL AND read.withdrawn_at IS NULL
)`;

/** Whether the message of the Source Record has an Item, on whichever of its copies. */
const hasItem = sql`EXISTS (SELECT 1 FROM item WHERE item.record_id IN ${copiesOf(sourceRecords.id)})`;

/**
 * Whether the message of the Source Record has an Item, on whichever of its copies, that still
 * needs its content at `now`: an Event or Lesson that has not ended, or a Task not done whose
 * Deadline has not passed (one without a Deadline until it is done). Days are read as widely as
 * for `windowTo`.
 */
const neededAt = (instant: Date) => {
  const now = sql`${instant.toISOString()}::timestamptz`;
  return sql`EXISTS (
  SELECT 1 FROM item
  LEFT JOIN event ON event.item_id = item.id
  LEFT JOIN lesson ON lesson.item_id = item.id
  LEFT JOIN task ON task.item_id = item.id
  WHERE item.record_id IN ${copiesOf(sourceRecords.id)}
    AND coalesce(
      event.ends_at >= ${now},
      (((event.last_day + 1)::timestamp AT TIME ZONE 'UTC' + interval '1 day') >= ${now}),
      lesson.ends_at >= ${now},
      task.status = 'open' AND (task.deadline IS NULL OR (((task.deadline + 1)::timestamp AT TIME ZONE 'UTC' + interval '1 day') >= ${now}))
    )
)`;
};

/** Instants certainly before and after a day, whatever the Family's time zone. */
const dayFrom = (day: SQLWrapper) => sql`((${day})::timestamp AT TIME ZONE 'UTC' - interval '1 day')`;
const dayTo = (day: SQLWrapper) => sql`(((${day}) + 1)::timestamp AT TIME ZONE 'UTC' + interval '1 day')`;

/** The day a done Task without a Deadline shows on: when it arrived, else when it was ticked. */
const arrivalDay = sql`(CASE WHEN ${tasks.status} = 'done' AND ${tasks.deadline} IS NULL THEN (coalesce(${sourceRecords.occurredAt}, ${tasks.doneAt}) AT TIME ZONE 'UTC')::date END)`;

/** Instants certainly before and after an Item's time, to find it by; null for a Task due at once. */
const windowFrom = sql<Date | null>`coalesce(${events.startsAt}, ${dayFrom(events.firstDay)}, ${lessons.startsAt}, ${dayFrom(tasks.deadline)}, ${dayFrom(arrivalDay)})`;
const windowTo = sql<Date | null>`coalesce(${events.endsAt}, ${dayTo(events.lastDay)}, ${lessons.endsAt}, ${dayTo(tasks.deadline)}, ${dayTo(arrivalDay)})`;

/** When a Source Record arrived: when its Source received it, or, for a stated Item, when it was first recorded. */
const arrivedAt = sql<Date>`coalesce(${sourceRecords.occurredAt}, ${sourceRecords.createdAt})`.mapWith(sourceRecords.occurredAt);

/** Whether a copy of the Item's message is in a Source that is shown, and that Source still has it. */
const shownInCopy = sql`EXISTS (
  SELECT 1 FROM source_record AS copy
  JOIN source AS copy_source ON copy_source.id = copy.source_id
  WHERE copy.id IN ${copiesOf(items.recordId)} AND copy.withdrawn_at IS NULL AND copy_source.shown
)`;

/** What a read of Items selects: the Item, when its Source Record arrived, and its detail row. */
const columns = {
  id: items.id,
  kind: items.kind,
  recordId: items.recordId,
  occurredAt: arrivedAt,
  event: events,
  task: tasks,
  lesson: lessons,
};

/** An Item as `columns` reads it. */
type Row = {
  id: string;
  kind: string;
  occurredAt: Date;
  event: typeof events.$inferSelect | null;
  task: typeof tasks.$inferSelect | null;
  lesson: typeof lessons.$inferSelect | null;
};

/** Items in Postgres, each with the detail row of its kind (ADR-0005). */
export class PostgresItemRepository implements ItemRepository {
  constructor(private readonly db: Database) {}

  async recordRun(run: SourceRun, read: ReadStated): Promise<RunRecorded> {
    return this.db.transaction(async (tx) => {
      const knownMessages: string[] = [];
      const outcome: StatedOutcome = { written: [], invalid: [] };
      const known = await attributesOfSource(tx, run.sourceId);
      const refused = new Set<string>();
      // An Origin naming no Source Attribute is one the Source no longer has.
      const withdrawn = [...run.withdrawn];
      for (const origin of run.origins) {
        if (origin.attributes.length === 0) {
          withdrawn.push(origin.externalId);
          continue;
        }
        const attributeIds = resolved(known, origin.attributes, refused);
        if (attributeIds === null) continue;
        if (origin.stated) await recordStated(tx, run, origin, origin.stated, attributeIds, read, outcome);
        else if (origin.message) {
          // A message past retention is ignored, so the caller removes the attachments it stored for it, as for a known one.
          const ignored = origin.occurredAt !== null && origin.occurredAt < run.retainedSince;
          if (ignored || (await recordMessage(tx, run, origin, origin.message, attributeIds))) knownMessages.push(origin.externalId);
        }
      }
      const withdrawnFiles = await this.withdraw(tx, run, withdrawn);
      const lastNewRecord = tx
        .select({ at: sql`max(${sourceRecords.createdAt})` })
        .from(sourceRecords)
        .where(eq(sourceRecords.sourceId, run.sourceId));
      await tx
        .update(sourceRuns)
        .set({
          syncCursor: cursorToJson(run.syncCursor),
          lastRunAt: run.at,
          lastSuccessAt: run.at,
          ...failureColumns(null),
          lastNewRecordAt: sql`(${lastNewRecord})`,
          ...(await invalidColumns(tx, run, outcome, withdrawn)),
          ...(await unknownColumns(tx, run, [...refused])),
        })
        .where(eq(sourceRuns.sourceId, run.sourceId));
      return { knownMessages, withdrawnFiles, invalid: outcome.invalid, refused: [...refused] };
    });
  }

  /**
   * Marks the Source Records the Source deleted as withdrawn, which deletes their Items, and
   * removes their messages' text and attachments. Returns the files of the removed attachments.
   */
  private async withdraw(tx: Transaction, run: SourceRun, externalIds: string[]): Promise<BlobRef[]> {
    if (externalIds.length === 0) return [];
    const withdrawn = await tx
      .update(sourceRecords)
      .set({ withdrawnAt: run.at, purgedAt: sql`(CASE WHEN ${sourceRecords.stated} IS NULL THEN ${run.at.toISOString()}::timestamptz END)`, sender: null, subject: null, body: null })
      .where(
        and(eq(sourceRecords.sourceId, run.sourceId), inArray(sourceRecords.externalId, externalIds), isNull(sourceRecords.withdrawnAt)),
      )
      .returning({ id: sourceRecords.id });
    if (withdrawn.length === 0) return [];
    const attachments = await tx
      .delete(sourceRecordAttachments)
      .where(inArray(sourceRecordAttachments.recordId, withdrawn.map((row) => row.id)))
      .returning({ blob: sourceRecordAttachments.blob });
    return attachments.map((row) => row.blob as BlobRef);
  }

  async purgeMessages(now: Date, retainedSince: Date): Promise<{ files: BlobRef[]; purged: number; deleted: number }> {
    return this.db.transaction(async (tx) => {
      const message = and(isNull(sourceRecords.stated), isNull(sourceRecords.purgedAt));
      // Past retention, or read and with no Item that still needs it. A message not read yet may still be retried.
      const unneeded = and(isNotNull(sourceRecords.processedAt), sql`NOT ${neededAt(now)}`);
      const purged = await tx
        .update(sourceRecords)
        .set({ purgedAt: now, sender: null, subject: null, body: null })
        .where(and(message, or(lt(sourceRecords.occurredAt, retainedSince), unneeded)))
        .returning({ id: sourceRecords.id });
      const files =
        purged.length === 0
          ? []
          : await tx
              .delete(sourceRecordAttachments)
              .where(inArray(sourceRecordAttachments.recordId, purged.map((row) => row.id)))
              .returning({ blob: sourceRecordAttachments.blob });
      const deleted = await tx
        .delete(sourceRecords)
        .where(
          and(isNull(sourceRecords.stated), lt(sourceRecords.occurredAt, retainedSince), sql`NOT ${hasItem}`),
        )
        .returning({ id: sourceRecords.id });
      return { files: files.map((row) => row.blob as BlobRef), purged: purged.length, deleted: deleted.length };
    });
  }

  async pendingMessages(limit: number): Promise<PendingMessage[]> {
    const rows = await this.db
      .select({ id: sourceRecords.id, sourceId: sourceRecords.sourceId, sentAt: arrivedAt, body: sourceRecords.body })
      .from(sourceRecords)
      .where(and(pendingMessage, sql`NOT ${waitsBehindCopy}`))
      .orderBy(asc(sourceRecords.createdAt), asc(sourceRecords.occurredAt))
      .limit(limit);
    const attachments =
      rows.length === 0
        ? []
        : await this.db
            .select()
            .from(sourceRecordAttachments)
            .where(inArray(sourceRecordAttachments.recordId, rows.map((row) => row.id)))
            .orderBy(asc(sourceRecordAttachments.position));
    return rows.map((row) => ({
      id: row.id as RawMessageId,
      sourceId: row.sourceId as SourceId,
      sentAt: row.sentAt,
      // The query takes only records with a body.
      body: row.body ?? "",
      attachments: attachments.flatMap((attachment) =>
        attachment.recordId === row.id
          ? [{ position: attachment.position, filename: attachment.filename, contentType: attachment.mediaType, blob: attachment.blob as BlobRef }]
          : [],
      ),
    }));
  }

  async pendingMessageCount(scope: { sourceId?: SourceId }): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sourceRecords)
      .where(and(pendingMessage, scope.sourceId ? eq(sourceRecords.sourceId, scope.sourceId) : undefined));
    return row?.count ?? 0;
  }

  async recordExtraction(extraction: Extraction): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Only the first successful extraction counts, should two runs overlap.
      const [message] = await tx
        .update(sourceRecords)
        .set({ processedAt: extraction.at })
        .where(and(eq(sourceRecords.id, extraction.messageId), isNull(sourceRecords.processedAt)))
        // Read in a copy already, should that one have been recorded while this one was read.
        .returning({ recordId: sourceRecords.id, readAsCopy: sql<boolean>`${readAsCopy(sourceRecords.id)}` });
      if (!message || message.readAsCopy) return;
      // Its copies that wait are read with it.
      await tx
        .update(sourceRecords)
        .set({ processedAt: extraction.at })
        .where(and(pendingMessage, sql`${sourceRecords.id} IN ${copiesOf(sql`${extraction.messageId}::uuid`)}`));
      for (const { position, problem } of extraction.attachmentProblems) {
        await tx
          .update(sourceRecordAttachments)
          .set({ conversionProblem: problem })
          .where(and(eq(sourceRecordAttachments.recordId, extraction.messageId), eq(sourceRecordAttachments.position, position)));
      }
      for (const item of extraction.items) await insertItem(tx, message.recordId, item, extraction.at);
    });
  }

  async findMessage(id: RawMessageId): Promise<RawMessage | null> {
    if (!uuidPattern.test(id)) return null;
    const [row] = await this.db.select().from(sourceRecords).where(eq(sourceRecords.id, id));
    // A record that is no message, or was withdrawn, has nothing to show; a purged one is a tombstone.
    if (!row || row.stated !== null || row.withdrawnAt !== null) return null;
    const attachments = await this.db
      .select()
      .from(sourceRecordAttachments)
      .where(eq(sourceRecordAttachments.recordId, id))
      .orderBy(asc(sourceRecordAttachments.position));
    const attributes = await this.db
      .select({ name: sourceAttributes.name })
      .from(sourceRecordAttributes)
      .innerJoin(sourceAttributes, eq(sourceAttributes.id, sourceRecordAttributes.attributeId))
      .where(eq(sourceRecordAttributes.recordId, id))
      .orderBy(asc(sourceAttributes.name));
    return {
      id,
      sourceId: row.sourceId as SourceId,
      sentAt: row.occurredAt ?? row.createdAt,
      sender: row.sender,
      subject: row.subject,
      attributes: attributes.map((attribute) => attribute.name),
      body: row.body ?? "",
      purgedAt: row.purgedAt,
      attachments: attachments.map(({ position, filename, mediaType, size, blob, conversionProblem }) => ({
        position,
        filename,
        contentType: mediaType,
        size,
        blob: blob as BlobRef,
        conversionProblem,
      })),
    };
  }

  async itemsOfMessage(id: RawMessageId): Promise<ProjectedItem[]> {
    if (!uuidPattern.test(id)) return [];
    return this.projected(sql`${items.recordId} IN ${copiesOf(sql`${id}::uuid`)}`, false);
  }

  async overlapping(from: Date, to: Date | null): Promise<ProjectedItem[]> {
    return this.projected(and(to ? lte(windowFrom, to) : undefined, gte(windowTo, from)));
  }

  async outstanding(): Promise<ProjectedItem[]> {
    return this.projected(eq(tasks.status, "open"));
  }

  async find(id: ItemId): Promise<ProjectedItem | null> {
    if (!uuidPattern.test(id)) return null;
    const [item] = await this.projected(eq(items.id, id));
    return item ?? null;
  }

  async setTaskDone(id: ItemId, at: Date | null): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db
      .update(tasks)
      .set({ status: at ? "done" : "open", doneAt: at })
      .where(eq(tasks.itemId, id));
  }

  async remove(id: ItemId): Promise<boolean> {
    if (!uuidPattern.test(id)) return false;
    const removed = await this.db.delete(items).where(eq(items.id, id)).returning({ id: items.id });
    return removed.length > 0;
  }

  /** The Items that match, in the order of their time; those of a hidden Source left out if `shownOnly`. */
  private query(where: SQL | undefined, shownOnly: boolean) {
    return selectItems(this.db)
      // Items of a hidden Source stay recorded, but leave the timeline and the feeds, unless a shown one has a copy of their message.
      .where(and(where, shownOnly ? or(eq(sources.shown, true), shownInCopy) : undefined))
      .orderBy(sql`${windowFrom} ASC NULLS LAST`, asc(items.createdAt));
  }

  /**
   * The Items that match, with the links and messages of every copy of their Source Record,
   * leaving out those of a hidden Source.
   */
  private async projected(where: SQL | undefined, shownOnly = true): Promise<ProjectedItem[]> {
    const rows = await this.query(where, shownOnly);
    const recordIds = rows.map((row) => row.recordId);
    const assignments = await assignmentsOf(this.db, recordIds);
    const copies = await copiesWithSource(this.db, recordIds, shownOnly);
    return rows.flatMap((row) => {
      const details = detailsOf(row);
      if (!details) return [];
      const origins = copies.get(row.recordId) ?? [];
      return [
        {
          ...details,
          id: row.id as ItemId,
          links: origins.flatMap(({ link, source }) => (link ? [{ url: link, ...source }] : [])),
          messages: origins.flatMap(({ id, isMessage, sentAt, source }) => (isMessage ? [{ id, ...source, sentAt }] : [])),
          assignments: assignments.get(row.recordId) ?? [],
        },
      ];
    });
  }
}

/** What an Item is, from its row and the detail row of its kind. */
function detailsOf(row: Row): ItemDetails | null {
  if (row.event) return eventDetails(row.event);
  if (row.task) return taskDetails(row.task, row.occurredAt);
  return row.lesson ? lessonDetails(row.lesson) : null;
}

/** An Event from its row: at a time, or over whole days. */
function eventDetails(row: typeof events.$inferSelect): ItemDetails {
  const { title, location, startsAt, endsAt, firstDay, lastDay, cancelled } = row;
  // The schema holds either both instants or both days.
  const span: TimeSpan =
    startsAt && endsAt ? { allDay: false, start: startsAt, end: endsAt } : { allDay: true, firstDay: firstDay as LocalDate, lastDay: lastDay as LocalDate };
  return { kind: "event", event: { title, span, place: location, cancelled } };
}

/** A Task arrived when its Source Record did. */
function taskDetails(row: typeof tasks.$inferSelect, arrivedAt: Date): ItemDetails {
  const { title, deadline, bring, cancelled, doneAt } = row;
  return { kind: "task", task: { title, deadline: deadline as LocalDate | null, bring, cancelled, doneAt, arrivedAt } };
}

/** A Lesson from its row, with its Timetable Change if it has one; a cancellation cancels it. */
function lessonDetails(row: typeof lessons.$inferSelect): ItemDetails {
  const { subject, startsAt, endsAt, room, teacher, previousRoom, previousTeacher, note } = row;
  const change = row.change as TimetableChangeKind | null;
  const lesson = { subject, span: { start: startsAt, end: endsAt }, room, teacher, cancelled: change === "cancellation" };
  return { kind: "lesson", lesson, change: change && { change, subject, span: lesson.span, room, teacher, previousRoom, previousTeacher, note } };
}

/**
 * Records a message, unless it was recorded before, as a message is read once. Returns whether it
 * was, so that the caller removes the attachments it stored for it again.
 */
async function recordMessage(tx: Transaction, run: SourceRun, origin: RunOrigin, message: StoredMessage, attributeIds: string[]): Promise<boolean> {
  const [row] = await tx
    .insert(sourceRecords)
    .values({
      sourceId: run.sourceId,
      externalId: origin.externalId,
      occurredAt: origin.occurredAt,
      sender: message.sender,
      subject: message.subject,
      body: message.body,
      createdAt: run.at,
      link: origin.link,
    })
    .onConflictDoUpdate({
      target: [sourceRecords.sourceId, sourceRecords.externalId],
      // A message keeps what it was first recorded with; a withdrawn one arriving again stays without it.
      set: { link: sql`coalesce(excluded.link, ${sourceRecords.link})`, withdrawnAt: null },
    })
    // A row the insert wrote has no previous version, so its xmax is 0.
    .returning({ id: sourceRecords.id, inserted: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error("recording a Source Record returned no row");
  await replaceAttributes(tx, row.id, attributeIds);
  if (!row.inserted) return true;
  // A copy of a message read already is not read again: it has its Items.
  await tx
    .update(sourceRecords)
    .set({ processedAt: run.at })
    .where(and(eq(sourceRecords.id, row.id), readAsCopy(sourceRecords.id)));
  if (message.attachments.length > 0) {
    await tx.insert(sourceRecordAttachments).values(
      message.attachments.map((attachment, position) => ({
        recordId: row.id,
        position,
        filename: attachment.filename,
        mediaType: attachment.contentType,
        blob: attachment.blob,
        sha256: attachment.sha256,
        size: attachment.size,
      })),
    );
  }
  return false;
}

/**
 * Records an entry stating its one Item. One stating what it stated before, and not withdrawn, is
 * not written, apart from where it came from if that changed. Otherwise its Item is overwritten,
 * keeping the Item itself, or written as new if it had none; one that is invalid leaves its Source
 * Record without an Item.
 */
async function recordStated(
  tx: Transaction,
  run: SourceRun,
  origin: RunOrigin,
  stated: Record<string, unknown>,
  attributeIds: string[],
  read: ReadStated,
  outcome: StatedOutcome,
): Promise<void> {
  if (await keptUnchanged(tx, run, origin, stated, attributeIds)) return;
  const fromWhere = { link: origin.link };
  const [row] = await tx
    .insert(sourceRecords)
    .values({ sourceId: run.sourceId, externalId: origin.externalId, occurredAt: null, stated, createdAt: run.at, ...fromWhere })
    .onConflictDoUpdate({
      target: [sourceRecords.sourceId, sourceRecords.externalId],
      set: { stated, ...fromWhere, withdrawnAt: null, processedAt: null },
    })
    .returning({ id: sourceRecords.id });
  if (!row) throw new Error("recording a Source Record returned no row");
  await replaceAttributes(tx, row.id, attributeIds);
  const [current] = await tx.select({ id: items.id, kind: items.kind }).from(items).where(eq(items.recordId, row.id)).limit(1);
  const result = read(stated);
  const problems = result.ok ? await writeStated(tx, row.id, current ?? null, result.item, run.at) : result.problems;
  if (problems.length === 0) {
    outcome.written.push(origin.externalId);
    return;
  }
  // The Item it stated before is no longer what the Source says.
  if (current) await tx.delete(items).where(eq(items.id, current.id));
  outcome.invalid.push({ externalId: origin.externalId, problems });
}

/**
 * Whether the entry states what it stated before and is not withdrawn, so that its Item is left as
 * it is; where it comes from is followed all the same.
 */
async function keptUnchanged(
  tx: Transaction,
  run: SourceRun,
  origin: RunOrigin,
  stated: Record<string, unknown>,
  attributeIds: string[],
): Promise<boolean> {
  const where = and(eq(sourceRecords.sourceId, run.sourceId), eq(sourceRecords.externalId, origin.externalId));
  const [known] = await tx
    .select({
      id: sourceRecords.id,
      // Compared as jsonb, which does not mind the order of the keys.
      unchanged: sql<boolean>`(${sourceRecords.stated} = ${JSON.stringify(stated)}::jsonb AND ${sourceRecords.withdrawnAt} IS NULL)`,
      sameOrigin: sql<boolean>`(${sourceRecords.link} IS NOT DISTINCT FROM ${origin.link})`,
    })
    .from(sourceRecords)
    .where(where);
  if (!known?.unchanged) return false;
  if (!known.sameOrigin) await tx.update(sourceRecords).set({ link: origin.link }).where(where);
  await replaceAttributes(tx, known.id, attributeIds);
  return true;
}

/**
 * Writes an entry's Item over the one it had, and marks the entry processed. Returns the check of
 * the schema it fails, which leaves it unwritten; none once it is written.
 */
async function writeStated(tx: Transaction, recordId: string, current: { id: string; kind: string } | null, item: StatedItem, at: Date): Promise<string[]> {
  try {
    // A savepoint, so that a failing check leaves the rest of the run to be recorded.
    await tx.transaction(async (savepoint) => {
      if (current && current.kind === item.kind) await updateDetail(savepoint, current.id, item);
      else {
        if (current) await savepoint.delete(items).where(eq(items.id, current.id));
        await insertItem(savepoint, recordId, item, at);
      }
      await savepoint.update(sourceRecords).set({ processedAt: at }).where(eq(sourceRecords.id, recordId));
    });
    return [];
  } catch (error) {
    const violated = checkViolated(error);
    if (violated === null) throw error;
    return [violated];
  }
}

/** The message of the check of the schema the error is about, or null if it is about something else. */
function checkViolated(error: unknown): string | null {
  for (let cause: unknown = error; typeof cause === "object" && cause !== null; cause = (cause as { cause?: unknown }).cause) {
    const { code, message } = cause as { code?: unknown; message?: unknown };
    if (code === "23514") return typeof message === "string" ? message : "a check of the schema failed";
  }
  return null;
}

/**
 * The Source's invalid records after the run: those it had, but for any written or withdrawn now,
 * and those found invalid now, with since when there have been any.
 */
async function invalidColumns(tx: Transaction, run: SourceRun, outcome: StatedOutcome, withdrawn: string[]) {
  const [previous] = await tx
    .select({ ids: sourceRuns.invalidRecords, since: sourceRuns.invalidRecordsSince })
    .from(sourceRuns)
    .where(eq(sourceRuns.sourceId, run.sourceId));
  const found = outcome.invalid.map((record) => record.externalId);
  const gone = new Set([...outcome.written, ...withdrawn, ...found]);
  const ids = [...(previous?.ids ?? []).filter((id) => !gone.has(id)), ...found];
  const since = ids.length === 0 ? null : (previous?.since ?? run.at);
  return { invalidRecords: ids, invalidRecordsSince: since };
}

/** The Source's unknown attributes after the run: those it refused now, since when there have been any. */
async function unknownColumns(tx: Transaction, run: SourceRun, refused: string[]) {
  const [previous] = await tx
    .select({ since: sourceRuns.unknownAttributesSince })
    .from(sourceRuns)
    .where(eq(sourceRuns.sourceId, run.sourceId));
  return { unknownAttributes: refused, unknownAttributesSince: refused.length === 0 ? null : (previous?.since ?? run.at) };
}

/** The Source Attributes a Source has, archived ones too. */
async function attributesOfSource(tx: Transaction, sourceId: string): Promise<KnownAttributes> {
  const rows = await tx
    .select({ id: sourceAttributes.id, externalId: sourceAttributes.externalId, archivedAt: sourceAttributes.archivedAt })
    .from(sourceAttributes)
    .where(eq(sourceAttributes.sourceId, sourceId));
  return new Map(rows.map((row) => [row.externalId, { id: row.id, archived: row.archivedAt !== null }]));
}

/**
 * The ids of the Source Attributes an Origin names; null if it names one that is unknown or
 * archived, which is added to `refused` along with the others like it.
 */
function resolved(known: KnownAttributes, named: string[], refused: Set<string>): string[] | null {
  const unknown = named.filter((externalId) => !known.has(externalId) || known.get(externalId)?.archived);
  for (const externalId of unknown) refused.add(externalId);
  return unknown.length > 0 ? null : named.flatMap((externalId) => known.get(externalId)?.id ?? []);
}

/** Gives a Source Record these Source Attributes, and no others, leaving its rows as they are if they already are. */
async function replaceAttributes(tx: Transaction, recordId: string, attributeIds: string[]): Promise<void> {
  const current = await tx
    .select({ id: sourceRecordAttributes.attributeId })
    .from(sourceRecordAttributes)
    .where(eq(sourceRecordAttributes.recordId, recordId));
  const wanted = new Set(attributeIds);
  if (current.length === wanted.size && current.every((row) => wanted.has(row.id))) return;
  await tx.delete(sourceRecordAttributes).where(eq(sourceRecordAttributes.recordId, recordId));
  await tx.insert(sourceRecordAttributes).values([...wanted].map((attributeId) => ({ recordId, attributeId })));
}

/**
 * For each Source Record, the Family Members assigned to each of its Source Attributes, in the
 * Family's order; archived Source Attributes count, as archiving never unassigns Items. Those of
 * the other copies of its message count as its own, unless their Source no longer has them.
 */
async function assignmentsOf(db: Database | Transaction, recordIds: string[]): Promise<Map<string, FamilyMemberId[][]>> {
  const assignments = new Map<string, FamilyMemberId[][]>();
  if (recordIds.length === 0) return assignments;
  const ofCopy = sql`${sourceRecordAttributes.recordId} IN (
    SELECT copy.id FROM source_record AS copy WHERE copy.id IN ${copiesOf(sourceRecords.id)} AND copy.withdrawn_at IS NULL
  )`;
  const rows = await db
    .select({ recordId: sourceRecords.id, attributeId: sourceRecordAttributes.attributeId, familyMemberId: sourceAttributeMembers.familyMemberId })
    .from(sourceRecords)
    .innerJoin(sourceRecordAttributes, ofCopy)
    .leftJoin(sourceAttributeMembers, eq(sourceAttributeMembers.attributeId, sourceRecordAttributes.attributeId))
    .leftJoin(familyMembers, eq(familyMembers.id, sourceAttributeMembers.familyMemberId))
    .where(inArray(sourceRecords.id, [...new Set(recordIds)]))
    .orderBy(asc(familyMembers.position));
  const byAttribute = new Map<string, { recordId: string; members: FamilyMemberId[] }>();
  for (const row of rows) {
    const key = `${row.recordId}/${row.attributeId}`;
    let entry = byAttribute.get(key);
    if (!entry) {
      entry = { recordId: row.recordId, members: [] };
      byAttribute.set(key, entry);
      assignments.set(row.recordId, [...(assignments.get(row.recordId) ?? []), entry.members]);
    }
    if (row.familyMemberId) entry.members.push(row.familyMemberId as FamilyMemberId);
  }
  return assignments;
}

/** A copy of a message as an Item names it: where it can be looked at, and the Source that has it. */
type Copy = {
  id: RawMessageId;
  link: string | null;
  /** Whether it is a message that still has its text. */
  isMessage: boolean;
  sentAt: Date;
  source: { sourceTypeId: SourceTypeId; sourceName: string | null };
};

/**
 * For each Source Record, the copies of its message that their Sources still have, itself among
 * them, in the order they arrived; only those of a shown Source if `shownOnly`.
 */
async function copiesWithSource(db: Database, recordIds: string[], shownOnly: boolean): Promise<Map<string, Copy[]>> {
  const copies = new Map<string, Copy[]>();
  if (recordIds.length === 0) return copies;
  const copy = alias(sourceRecords, "copy");
  const rows = await db
    .select({
      recordId: sourceRecords.id,
      id: copy.id,
      link: copy.link,
      isMessage: sql<boolean>`(${copy.body} IS NOT NULL)`,
      sentAt: sql<Date>`coalesce(${copy.occurredAt}, ${copy.createdAt})`.mapWith(copy.createdAt),
      sourceTypeId: sources.sourceTypeId,
      sourceName: sources.name,
    })
    .from(sourceRecords)
    .innerJoin(copy, sql`${copy.id} IN ${copiesOf(sourceRecords.id)}`)
    .innerJoin(sources, eq(sources.id, copy.sourceId))
    .where(and(inArray(sourceRecords.id, [...new Set(recordIds)]), isNull(copy.withdrawnAt), shownOnly ? eq(sources.shown, true) : undefined))
    .orderBy(asc(copy.createdAt), asc(copy.id));
  for (const { recordId, id, sourceTypeId, sourceName, ...rest } of rows) {
    const source = { sourceTypeId: sourceTypeId as SourceTypeId, sourceName };
    copies.set(recordId, [...(copies.get(recordId) ?? []), { id: id as RawMessageId, ...rest, source }]);
  }
  return copies;
}

/** Items with their Source Record, Source and detail row. */
function selectItems(db: Database | Transaction) {
  return db
    .select(columns)
    .from(items)
    .innerJoin(sourceRecords, eq(sourceRecords.id, items.recordId))
    .innerJoin(sources, eq(sources.id, sourceRecords.sourceId))
    .leftJoin(events, eq(events.itemId, items.id))
    .leftJoin(tasks, eq(tasks.itemId, items.id))
    .leftJoin(lessons, eq(lessons.itemId, items.id))
    .$dynamic();
}

/** Writes a new Item with the detail row of its kind. */
async function insertItem(tx: Transaction, recordId: string, item: StatedItem | NewItem, at: Date): Promise<void> {
  const [row] = await tx
    .insert(items)
    .values({ kind: item.kind, recordId, createdAt: at })
    .returning({ id: items.id });
  if (!row) throw new Error("writing an Item returned no row");
  if (item.kind === "event") await tx.insert(events).values({ itemId: row.id, ...eventColumns(item.event) });
  else if (item.kind === "task") await tx.insert(tasks).values({ itemId: row.id, ...taskColumns(item.task) });
  else await tx.insert(lessons).values({ itemId: row.id, ...lessonColumns(item) });
}

/**
 * Overwrites an Item with what its Source states now. A Task keeps whether it is done: that is the
 * Family's to say by ticking it, so only what the Source states changes.
 */
async function updateDetail(tx: Transaction, id: string, item: StatedItem): Promise<void> {
  if (item.kind === "event") await tx.update(events).set(eventColumns(item.event)).where(eq(events.itemId, id));
  else if (item.kind === "task") {
    const { title, deadline, bring } = taskColumns(item.task);
    await tx.update(tasks).set({ title, deadline, bring }).where(eq(tasks.itemId, id));
  } else await tx.update(lessons).set(lessonColumns(item)).where(eq(lessons.itemId, id));
}

/** An Event as the columns of its row. */
function eventColumns(event: Event) {
  const { span } = event;
  return {
    title: event.title,
    location: event.place,
    startsAt: span.allDay ? null : span.start,
    endsAt: span.allDay ? null : span.end,
    firstDay: span.allDay ? span.firstDay : null,
    lastDay: span.allDay ? span.lastDay : null,
    cancelled: event.cancelled,
  };
}

/** What a message states about a Task, as columns. */
function taskColumns(task: StatedTask) {
  return { title: task.title, deadline: task.deadline, bring: task.bring, cancelled: task.cancelled };
}

const asPlanned = { change: null, previousRoom: null, previousTeacher: null, note: null };

/** A Lesson and its Timetable Change as the columns of its row. */
function lessonColumns(item: Extract<StatedItem, { kind: "lesson" }>) {
  const { subject, span, room, teacher } = item.lesson;
  return { subject, startsAt: span.start, endsAt: span.end, room, teacher, ...(item.change ?? asPlanned) };
}
