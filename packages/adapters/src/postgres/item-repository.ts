import type {
  Extraction,
  InvalidRecord,
  ItemDetails,
  ItemOfMessage,
  ItemRepository,
  NewItem,
  PendingMessage,
  ProjectedItem,
  RawMessage,
  ReadStated,
  SourceRun,
  StatedItem,
  StoredMessage,
} from "@family-agenda/application";
import type { BlobRef, Event, ItemId, StatedTask, LocalDate, RawMessageId, SourceId, SourceTypeId, TimeSpan, TimetableChangeKind } from "@family-agenda/domain";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { uuidPattern } from "../uuid";
import type { Database } from "./database";
import { cursorToJson, failureColumns } from "./repositories";
import { events, items, lessons, sourceRecordAttachments, sourceRecords, sourceRuns, sources, tasks } from "./schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type RunOrigin = SourceRun["origins"][number];

/** What recording a run's stated Source Records found: which wrote their Item, and which were invalid. */
type StatedOutcome = { written: string[]; invalid: InvalidRecord[] };

/** A message, with its text, waiting for its one successful extraction. */
const pendingMessage = and(isNull(sourceRecords.processedAt), isNotNull(sourceRecords.body), isNull(sourceRecords.withdrawnAt));

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

/** What a read of Items selects: the Item, its Source Record and Source, and its detail row. */
const columns = {
  id: items.id,
  kind: items.kind,
  recordId: items.recordId,
  occurredAt: arrivedAt,
  link: sourceRecords.link,
  isMessage: sql<boolean>`(${sourceRecords.body} IS NOT NULL)`,
  sourceId: sourceRecords.sourceId,
  part: sourceRecords.part,
  sourceTypeId: sources.sourceTypeId,
  sourceName: sources.name,
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

/** Items in Postgres, each with the detail row of its kind (ADR-0016). */
export class PostgresItemRepository implements ItemRepository {
  constructor(private readonly db: Database) {}

  async recordRun(run: SourceRun, read: ReadStated): Promise<{ knownMessages: string[]; withdrawnFiles: BlobRef[]; invalid: InvalidRecord[] }> {
    return this.db.transaction(async (tx) => {
      const knownMessages: string[] = [];
      const outcome: StatedOutcome = { written: [], invalid: [] };
      for (const origin of run.origins) {
        if (origin.stated) await recordStated(tx, run, origin, origin.stated, read, outcome);
        else if (origin.message && (await recordMessage(tx, run, origin, origin.message))) knownMessages.push(origin.externalId);
      }
      const withdrawnFiles = await this.withdraw(tx, run);
      const lastNewOrigin = tx
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
          lastNewOriginAt: sql`(${lastNewOrigin})`,
          ...(await invalidColumns(tx, run, outcome)),
        })
        .where(eq(sourceRuns.sourceId, run.sourceId));
      return { knownMessages, withdrawnFiles, invalid: outcome.invalid };
    });
  }

  /**
   * Marks the Source Records the Source deleted as withdrawn, which deletes their Items, and
   * removes their messages' text and attachments. Returns the files of the removed attachments.
   */
  private async withdraw(tx: Transaction, run: SourceRun): Promise<BlobRef[]> {
    if (run.withdrawn.length === 0) return [];
    const withdrawn = await tx
      .update(sourceRecords)
      .set({ withdrawnAt: run.at, sender: null, subject: null, body: null })
      .where(
        and(eq(sourceRecords.sourceId, run.sourceId), inArray(sourceRecords.externalId, run.withdrawn), isNull(sourceRecords.withdrawnAt)),
      )
      .returning({ id: sourceRecords.id });
    if (withdrawn.length === 0) return [];
    const attachments = await tx
      .delete(sourceRecordAttachments)
      .where(inArray(sourceRecordAttachments.recordId, withdrawn.map((row) => row.id)))
      .returning({ blob: sourceRecordAttachments.blob });
    return attachments.map((row) => row.blob as BlobRef);
  }

  async pendingMessages(limit: number): Promise<PendingMessage[]> {
    const rows = await this.db
      .select({ id: sourceRecords.id, sourceId: sourceRecords.sourceId, sentAt: arrivedAt, body: sourceRecords.body })
      .from(sourceRecords)
      .where(pendingMessage)
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
        .returning({ recordId: sourceRecords.id });
      if (!message) return;
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
    // A record without a body is no message, or one withdrawn.
    if (!row || row.body === null) return null;
    const attachments = await this.db
      .select()
      .from(sourceRecordAttachments)
      .where(eq(sourceRecordAttachments.recordId, id))
      .orderBy(asc(sourceRecordAttachments.position));
    return {
      id,
      sourceId: row.sourceId as SourceId,
      sentAt: row.occurredAt ?? row.createdAt,
      attributes: row.attributes,
      body: row.body,
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

  async itemsOfMessage(id: RawMessageId): Promise<ItemOfMessage[]> {
    if (!uuidPattern.test(id)) return [];
    const rows = await this.query(eq(items.recordId, id), false);
    return rows.flatMap((row) => {
      const details = detailsOf(row);
      return details ? [{ ...details, id: row.id as ItemId }] : [];
    });
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
      // Items of a hidden Source stay recorded, but leave the timeline and the feeds.
      .where(and(where, shownOnly ? eq(sources.shown, true) : undefined))
      .orderBy(sql`${windowFrom} ASC NULLS LAST`, asc(items.createdAt));
  }

  /** The Items that match, with the link of their Source Record, leaving out those of a hidden Source. */
  private async projected(where: SQL | undefined): Promise<ProjectedItem[]> {
    const rows = await this.query(where, true);
    return rows.flatMap((row) => {
      const details = detailsOf(row);
      if (!details) return [];
      const source = { sourceTypeId: row.sourceTypeId as SourceTypeId, sourceName: row.sourceName };
      return [
        {
          ...details,
          id: row.id as ItemId,
          links: row.link ? [{ url: row.link, ...source }] : [],
          messages: row.isMessage ? [{ id: row.recordId as RawMessageId, ...source, sentAt: row.occurredAt }] : [],
          sources: [{ sourceId: row.sourceId as SourceId, part: row.part }],
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
async function recordMessage(tx: Transaction, run: SourceRun, origin: RunOrigin, message: StoredMessage): Promise<boolean> {
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
      attributes: origin.attributes,
      link: origin.link,
      part: origin.part,
      thread: message.thread,
    })
    .onConflictDoUpdate({
      target: [sourceRecords.sourceId, sourceRecords.externalId],
      // A message keeps what it was first recorded with; a withdrawn one arriving again stays without it.
      set: { attributes: origin.attributes, link: sql`coalesce(excluded.link, ${sourceRecords.link})`, withdrawnAt: null },
    })
    // A row the insert wrote has no previous version, so its xmax is 0.
    .returning({ id: sourceRecords.id, inserted: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error("recording a Source Record returned no row");
  if (!row.inserted) return true;
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
  read: ReadStated,
  outcome: StatedOutcome,
): Promise<void> {
  if (await keptUnchanged(tx, run, origin, stated)) return;
  const fromWhere = { attributes: origin.attributes, link: origin.link, part: origin.part };
  const [row] = await tx
    .insert(sourceRecords)
    .values({ sourceId: run.sourceId, externalId: origin.externalId, occurredAt: null, stated, createdAt: run.at, ...fromWhere })
    .onConflictDoUpdate({
      target: [sourceRecords.sourceId, sourceRecords.externalId],
      set: { stated, ...fromWhere, withdrawnAt: null, processedAt: null },
    })
    .returning({ id: sourceRecords.id });
  if (!row) throw new Error("recording a Source Record returned no row");
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
async function keptUnchanged(tx: Transaction, run: SourceRun, origin: RunOrigin, stated: Record<string, unknown>): Promise<boolean> {
  const where = and(eq(sourceRecords.sourceId, run.sourceId), eq(sourceRecords.externalId, origin.externalId));
  const [known] = await tx
    .select({
      // Compared as jsonb, which does not mind the order of the keys.
      unchanged: sql<boolean>`(${sourceRecords.stated} = ${JSON.stringify(stated)}::jsonb AND ${sourceRecords.withdrawnAt} IS NULL)`,
      sameOrigin: sql<boolean>`(${sourceRecords.attributes} = ${JSON.stringify(origin.attributes)}::jsonb AND ${sourceRecords.link} IS NOT DISTINCT FROM ${origin.link} AND ${sourceRecords.part} IS NOT DISTINCT FROM ${origin.part})`,
    })
    .from(sourceRecords)
    .where(where);
  if (!known?.unchanged) return false;
  if (!known.sameOrigin) await tx.update(sourceRecords).set({ attributes: origin.attributes, link: origin.link, part: origin.part }).where(where);
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
async function invalidColumns(tx: Transaction, run: SourceRun, outcome: StatedOutcome) {
  const [previous] = await tx
    .select({ ids: sourceRuns.invalidRecords, since: sourceRuns.invalidRecordsSince })
    .from(sourceRuns)
    .where(eq(sourceRuns.sourceId, run.sourceId));
  const found = outcome.invalid.map((record) => record.externalId);
  const gone = new Set([...outcome.written, ...run.withdrawn, ...found]);
  const ids = [...(previous?.ids ?? []).filter((id) => !gone.has(id)), ...found];
  const since = ids.length === 0 ? null : (previous?.since ?? run.at);
  return { invalidRecords: ids, invalidRecordsSince: since };
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

/** Overwrites an Item with what its Source states now. */
async function updateDetail(tx: Transaction, id: string, item: StatedItem): Promise<void> {
  if (item.kind === "event") await tx.update(events).set(eventColumns(item.event)).where(eq(events.itemId, id));
  else await tx.update(lessons).set(lessonColumns(item)).where(eq(lessons.itemId, id));
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
