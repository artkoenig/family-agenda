import { localDateTime, type FamilyMember, type ItemId, type LocalDate } from "@family-agenda/domain";
import { openAgendaAccess, type AgendaAccess, type AgendaFeed } from "./agendas";
import { concernsOf } from "./assignment";
import type { BlobStore, Clock, FamilyMemberRepository, ItemRepository, ProjectedItem, RawMessage, SourceRepository } from "./ports";

/** One file of an Export: its path inside the ZIP, and its contents, read only when the ZIP gets to it. */
export type ExportEntry = { path: string; contents: string | AsyncIterable<Uint8Array> };

/** The version of the Export's JSON format, raised when a field changes its meaning or goes away. */
export const exportFormatVersion = 1;

export type FamilyExportDeps = {
  clock: Clock;
  /** The IANA time zone the Family lives in now, which decides the date in the file's name. */
  timeZone: () => Promise<string>;
  members: FamilyMemberRepository;
  agendas: Pick<AgendaAccess, "list" | "feed">;
  sources: SourceRepository;
  items: ItemRepository;
  blobs: BlobStore;
};

/** The file extension of each photo format. */
const photoExtensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/**
 * A file name that is safe in a ZIP on every system: no folders, no characters that some systems
 * refuse, no leading dot, not too long; "file" if nothing is left.
 */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what it removes
  const safe = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").replace(/^[.\s]+/, "").slice(-100).trim();
  return safe.length > 0 ? safe : "file";
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** An Item as the Export's JSON holds it: whom it concerns in place of the assignments it is derived from. */
function exportedItem(item: ProjectedItem) {
  const rest = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "assignments"));
  return { ...rest, concerns: concernsOf(item) };
}

/** The ids of the Items an Agenda's feed holds: its Events, Tasks, and the Lessons of its school days. */
function itemIdsOf(feed: AgendaFeed): Set<ItemId> {
  return new Set([
    ...feed.events.map((event) => event.itemId),
    ...feed.tasks.map((task) => task.itemId),
    ...feed.schoolDays.flatMap((day) => [...day.lessons, ...day.timetableChanges].map((lesson) => lesson.itemId)),
  ]);
}

/**
 * The Family's data as files for an Admin to take elsewhere (the Export): its Family Members,
 * Agendas, Sources and Items as JSON, each Agenda's feed as iCalendar too, and the messages it
 * keeps with their attachments. Nothing secret is among them: no Source's configuration, no
 * Agenda's id, which is its Agenda Link (ADR-0004), no key. See docs/export.md for the format.
 */
export function createFamilyExport(deps: FamilyExportDeps) {
  const { clock, timeZone, members, agendas, sources, items, blobs } = deps;

  async function* photos(family: FamilyMember[]): AsyncGenerator<ExportEntry> {
    for (const member of family) {
      const path = photoPathOf(member);
      const contents = member.photo && path ? await blobs.stream(member.photo.blob) : null;
      if (path && contents) yield { path, contents };
    }
  }

  async function* agendaFiles(calendar: (feed: AgendaFeed) => string, all: ProjectedItem[]): AsyncGenerator<ExportEntry> {
    const summaries = await agendas.list();
    for (const [index, summary] of summaries.entries()) {
      const feed = await agendas.feed(summary.id, { access: openAgendaAccess });
      if (!feed) continue;
      const shown = itemIdsOf(feed);
      const folder = `agendas/agenda-${index + 1}`;
      yield { path: `${folder}/feed.ics`, contents: calendar(feed) };
      yield { path: `${folder}/items.json`, contents: json(all.filter((item) => shown.has(item.id)).map(exportedItem)) };
    }
  }

  /** The files of a message's attachments that the Blob Store still holds, by position, into `files`. */
  async function* attachmentFiles(folder: string, message: RawMessage, files: Map<number, string>): AsyncGenerator<ExportEntry> {
    for (const attachment of message.attachments) {
      const contents = await blobs.stream(attachment.blob);
      if (!contents) continue;
      const path = `attachments/${attachment.position}-${safeFileName(attachment.filename)}`;
      files.set(attachment.position, path);
      yield { path: `${folder}/${path}`, contents };
    }
  }

  async function* messageFiles(message: RawMessage): AsyncGenerator<ExportEntry> {
    const folder = `messages/${message.id}`;
    const files = new Map<number, string>();
    yield* attachmentFiles(folder, message, files);
    const body = message.body.length > 0 ? "body.txt" : null;
    if (body) yield { path: `${folder}/${body}`, contents: message.body };
    const written = (await items.itemsOfMessage(message.id)).map((item) => item.id);
    yield { path: `${folder}/message.json`, contents: json(exportedMessage(message, body, files, written)) };
  }

  return {
    /** The date the Export is made on, on the Family's clocks, for the file's name. */
    async exportedOn(): Promise<LocalDate> {
      return localDateTime(clock.now(), await timeZone()).date;
    },

    /**
     * The Export's files, made one by one as they are asked for, so that a large Family's never
     * need to fit in memory. `calendar` writes an Agenda's feed as iCalendar, without its link.
     */
    async *entries(calendar: (feed: AgendaFeed) => string): AsyncGenerator<ExportEntry> {
      const family = await members.list();
      const summaries = await agendas.list();
      const all = await items.all();
      yield {
        path: "family.json",
        contents: json({
          format: "family-agenda-export",
          version: exportFormatVersion,
          exportedAt: clock.now(),
          timeZone: await timeZone(),
          familyMembers: family.map((member) => ({
            id: member.id,
            name: member.name,
            colour: member.colour,
            avatar: member.avatar,
            photo: photoPathOf(member),
          })),
          agendas: summaries.map(({ layout, memberIds, horizonDays }, index) => ({
            folder: `agendas/agenda-${index + 1}`,
            layout,
            memberIds,
            horizonDays,
          })),
          sources: (await sources.list()).map(({ id, sourceTypeId, name, shown }) => ({ id, sourceTypeId, name, shown })),
        }),
      };
      yield* photos(family);
      yield { path: "items.json", contents: json(all.map(exportedItem)) };
      yield* agendaFiles(calendar, all);
      for (const id of await items.messageIds()) {
        const message = await items.findMessage(id);
        if (message) yield* messageFiles(message);
      }
    },
  };
}

export type FamilyExport = ReturnType<typeof createFamilyExport>;

/** Where a Family Member's photo is in the Export; null if they have none. */
function photoPathOf(member: FamilyMember): string | null {
  return member.photo ? `family-members/${member.id}.${photoExtensions[member.photo.contentType] ?? "bin"}` : null;
}

/** A message as `message.json` holds it, naming the files of its body and attachments that the Export holds. */
function exportedMessage(message: RawMessage, body: string | null, files: Map<number, string>, itemIds: ItemId[]) {
  return {
    id: message.id,
    sourceId: message.sourceId,
    sentAt: message.sentAt,
    sender: message.sender,
    subject: message.subject,
    attributes: message.attributes,
    purgedAt: message.purgedAt,
    body,
    attachments: message.attachments.map(({ position, filename, contentType, size }) => ({
      position,
      filename,
      contentType,
      size,
      file: files.get(position) ?? null,
    })),
    itemIds,
  };
}
