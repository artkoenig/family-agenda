import type {
  ApplyRevisions,
  Extraction,
  ItemDetails,
  ItemOfMessage,
  ItemRepository,
  NewItem,
  PendingMessage,
  ProjectedItem,
  RawMessage,
  SourceRun,
  StatedItem,
} from "@family-agenda/application";
import type { BlobRef, ItemId, LocalDate, RawMessageId, SourceId, SourceTypeId, TimeSpan, TimetableChangeKind } from "@family-agenda/domain";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { uuidPattern } from "../uuid";
import type { Database } from "./database";
import { cursorToJson, failureColumns } from "./repositories";
import { events, items, lessons, sourceRecordAttachments, sourceRecords, sourceRuns, sources, tasks } from "./schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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

/** What a read of Items selects: the Item, its Source Record and Source, and its detail row. */
const columns = {
  id: items.id,
  kind: items.kind,
  recordId: items.recordId,
  occurredAt: sourceRecords.occurredAt,
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

  async recordRun(run: SourceRun, apply: ApplyRevisions): Promise<{ knownMessages: string[]; withdrawnFiles: BlobRef[] }> {
    return this.db.transaction(async (tx) => {
      const knownMessages: string[] = [];
      for (const origin of run.origins) {
        const { message } = origin;
        const [row] = await tx
          .insert(sourceRecords)
          .values({
            sourceId: run.sourceId,
            externalId: origin.externalId,
            occurredAt: origin.occurredAt,
            sender: message?.sender ?? null,
            subject: message?.subject ?? null,
            body: message?.body ?? null,
            createdAt: run.at,
            attributes: origin.attributes,
            link: origin.link,
            part: origin.part,
            thread: message?.thread ?? null,
          })
          .onConflictDoUpdate({
            target: [sourceRecords.sourceId, sourceRecords.externalId],
            // A later appearance without a link, such as a cancellation, keeps the link. A message
            // keeps what it was first recorded with; a withdrawn one arriving again stays without it.
            set: {
              attributes: origin.attributes,
              link: sql`coalesce(excluded.link, ${sourceRecords.link})`,
              withdrawnAt: null,
            },
          })
          // A row the insert wrote has no previous version, so its xmax is 0.
          .returning({ id: sourceRecords.id, inserted: sql<boolean>`(xmax = 0)` });
        if (!row) throw new Error("recording a Source Record returned no row");
        if (message && !row.inserted) knownMessages.push(origin.externalId);
        else if (message && message.attachments.length > 0) {
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
        if (!message && origin.revisions.length > 0) await this.state(tx, row.id, apply, origin.revisions);
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
        })
        .where(eq(sourceRuns.sourceId, run.sourceId));
      return { knownMessages, withdrawnFiles };
    });
  }

  /** Writes the one Item of a calendar or timetable entry as the plugin's Revisions leave it, keeping a Task's tick. */
  private async state(tx: Transaction, recordId: string, apply: ApplyRevisions, revisions: Parameters<ApplyRevisions>[1]): Promise<void> {
    const [row] = await selectItems(tx).where(eq(items.recordId, recordId)).limit(1);
    const current = row ? detailsOf(row) : null;
    const next = apply(current && statedOf(current), revisions);
    if (row && next?.kind === row.kind) await updateDetail(tx, row.id, next);
    else await replaceItem(tx, recordId, row?.id ?? null, next);
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
      .select({ id: sourceRecords.id, sourceId: sourceRecords.sourceId, sentAt: sourceRecords.occurredAt, body: sourceRecords.body })
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
      sentAt: row.occurredAt,
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

/** An Item as a plugin's Revisions apply to it. */
function statedOf(details: ItemDetails): StatedItem {
  if (details.kind === "event") return details;
  if (details.kind === "task") {
    const { title, deadline, bring, cancelled } = details.task;
    return { kind: "task", task: { title, deadline, bring, cancelled } };
  }
  const { subject, span, room, teacher } = details.lesson;
  const { change } = details;
  return {
    kind: "lesson",
    lesson: { subject, span, room, teacher },
    change: change && { change: change.change, previousRoom: change.previousRoom, previousTeacher: change.previousTeacher, note: change.note },
  };
}

/** Deletes the entry's Item, if any, and writes the one its Source states now, if any. */
async function replaceItem(tx: Transaction, recordId: string, current: string | null, next: StatedItem | null): Promise<void> {
  if (current) await tx.delete(items).where(eq(items.id, current));
  if (next) await insertItem(tx, recordId, next);
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
async function insertItem(tx: Transaction, recordId: string, item: StatedItem | NewItem, at?: Date): Promise<void> {
  const [row] = await tx
    .insert(items)
    .values({ kind: item.kind, recordId, ...(at ? { createdAt: at } : {}) })
    .returning({ id: items.id });
  if (!row) throw new Error("writing an Item returned no row");
  if (item.kind === "event") await tx.insert(events).values({ itemId: row.id, ...eventColumns(item.event) });
  else if (item.kind === "task") await tx.insert(tasks).values({ itemId: row.id, ...taskColumns(item.task) });
  else await tx.insert(lessons).values({ itemId: row.id, ...lessonColumns(item) });
}

/** Overwrites an Item with what its Source states now, keeping whether a Task was ticked done. */
async function updateDetail(tx: Transaction, id: string, item: StatedItem): Promise<void> {
  if (item.kind === "event") await tx.update(events).set(eventColumns(item.event)).where(eq(events.itemId, id));
  else if (item.kind === "task") await tx.update(tasks).set(taskColumns(item.task)).where(eq(tasks.itemId, id));
  else await tx.update(lessons).set(lessonColumns(item)).where(eq(lessons.itemId, id));
}

/** An Event as the columns of its row. */
function eventColumns(event: Extract<StatedItem, { kind: "event" }>["event"]) {
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

/** What a Source states about a Task, as columns; its tick is left as it is. */
function taskColumns(task: Extract<StatedItem, { kind: "task" }>["task"]) {
  return { title: task.title, deadline: task.deadline, bring: task.bring, cancelled: task.cancelled };
}

const asPlanned = { change: null, previousRoom: null, previousTeacher: null, note: null };

/** A Lesson and its Timetable Change as the columns of its row. */
function lessonColumns(item: Extract<StatedItem, { kind: "lesson" }>) {
  const { subject, span, room, teacher } = item.lesson;
  return { subject, startsAt: span.start, endsAt: span.end, room, teacher, ...(item.change ?? asPlanned) };
}
