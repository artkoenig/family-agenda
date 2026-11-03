import { createHmac } from "node:crypto";
import {
  sdkVersion,
  SourceError,
  type Choice,
  type LessonFields,
  type Origin,
  type PluginRevision,
  type RunContext,
  type SourcePlugin,
  type TimetableChangeFields,
} from "@family-agenda/source-sdk";

export type WebUntisPluginOptions = {
  /** How the plugin reaches WebUntis; recorded responses in tests. */
  fetch?: typeof globalThis.fetch;
  /** How long a request may take before the run fails. */
  timeoutMs?: number;
};

/** How many days of Timetable each run reads, today included. */
const daysAhead = 14;

/** A Lesson as the last run saw it, with its Timetable Change if it had one. */
type SeenLesson = { day: string; lesson: Required<LessonFields>; cancelled: boolean; change: Required<TimetableChangeFields> | null };

/** The sync cursor: the children of the account, and every Lesson of the days read, by key. */
type State = { children: Choice[]; lessons: Record<string, SeenLesson> };

type Json = Record<string, unknown>;

type Child = { id: number; name: string };

/**
 * Reads the Timetables of the children of a WebUntis parent account through the endpoints of the
 * Untis Mobile app, which authenticate each request with a one-time password from the key the
 * account shares with Untis Mobile (research in #2). One login lists the children; each child's
 * Timetable is then read as a STUDENT's. Its Lessons and Timetable Changes are stated as Revisions
 * keyed by child and the id Untis gives the Lesson, at the time of the poll. Untis gives the Timetable as it is now, not
 * its changes, so each run compares it with what the last run saw and states only what changed.
 */
export function createWebUntisPlugin(options: WebUntisPluginOptions = {}): SourcePlugin {
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  /** Calls a method of the mobile API with a fresh one-time password, and returns its result. */
  async function call(context: RunContext, method: string, params: Json): Promise<Json> {
    const { server, school, user } = connectionOf(context);
    const url = new URL(`https://${server}/WebUntis/jsonrpc_intern.do`);
    url.searchParams.set("m", method);
    url.searchParams.set("school", school);
    url.searchParams.set("v", "i2.2");
    const auth = { user, otp: oneTimePassword(context.config.secrets.secret ?? "", context.now), clientTime: context.now.getTime() };
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "family-agenda", method, params: [{ ...params, auth }], jsonrpc: "2.0" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw SourceError.temporary(`WebUntis could not be reached: ${messageOf(error)}`);
    }
    if (!response.ok) throw httpError(response);
    return parseAnswer(await readJson(response), method);
  }

  function httpError(response: Response): SourceError {
    const message = `WebUntis answered with HTTP ${response.status}.`;
    return response.status === 404 ? SourceError.definite(message) : SourceError.temporary(message);
  }

  async function readJson(response: Response): Promise<Json> {
    try {
      return (await response.json()) as Json;
    } catch {
      throw SourceError.temporary("WebUntis answered with no JSON.");
    }
  }

  function parseAnswer(answer: Json, method: string): Json {
    const error = answer.error as Json | undefined;
    if (error) throw SourceError.definite(`WebUntis refused ${method}: ${String(error.message ?? error.code)}`);
    if (!isObject(answer.result)) throw SourceError.temporary(`WebUntis answered ${method} without a result.`);
    return answer.result;
  }

  /** The children of the account, or the account itself if it is a student's. */
  async function childrenOf(context: RunContext): Promise<Child[]> {
    const userData = (await call(context, "getUserData2017", {})).userData;
    if (!isObject(userData)) throw SourceError.temporary("WebUntis answered without the account's data.");
    const children = (Array.isArray(userData.children) ? userData.children : []).filter(isObject).flatMap(childOf);
    if (children.length > 0) return children;
    if (userData.elemType === "STUDENT" && typeof userData.elemId === "number") {
      return [{ id: userData.elemId, name: text(userData.displayName) ?? String(userData.elemId) }];
    }
    throw SourceError.definite("The WebUntis account lists no children.");
  }

  async function poll(context: RunContext) {
    const previous = parseState(context.syncCursor);
    const children = await childrenOf(context);
    const ticked = ticksOf(context.config.plain.children);
    const read = ticked.length > 0 ? children.filter((child) => ticked.includes(String(child.id))) : children;
    const today = localDate(context.now, context.timeZone);
    const lastDay = addDays(today, daysAhead - 1);

    const origins: Origin[] = [];
    const withdrawn: string[] = [];
    const lessons: Record<string, SeenLesson> = {};
    for (const child of read) {
      const result = await call(context, "getTimetable2017", {
        id: child.id,
        type: "STUDENT",
        startDate: Number(today.replaceAll("-", "")),
        endDate: Number(lastDay.replaceAll("-", "")),
        masterDataTimestamp: 0,
        timetableTimestamp: 0,
        timetableTimestamps: [],
      });
      const attributes = { child: child.name };
      for (const [lessonId, seen] of seenIn(result, context.timeZone)) {
        const key = `${child.id}/${lessonId}`;
        lessons[key] = seen;
        const revisions = revisionsFor(key, previous.lessons[key], seen);
        if (revisions.length > 0) origins.push({ externalId: key, occurredAt: context.now, attributes, content: { kind: "revisions", revisions } });
      }
    }
    // A Lesson of the days read that has gone from the Timetable, or whose child is no longer
    // read, is withdrawn with its Timetable Change: the school no longer plans it, which is not a
    // cancellation. One of a day that has passed is forgotten and stays as it was.
    const isWithdrawn = (key: string, seen: SeenLesson): boolean => {
      if (key in lessons || seen.day < today) return false;
      const childRead = read.some((child) => key.startsWith(`${child.id}/`));
      return !childRead || seen.day <= lastDay;
    };
    for (const [key, seen] of Object.entries(previous.lessons)) {
      if (isWithdrawn(key, seen)) withdrawn.push(key);
    }
    const state: State = { children: children.map((child) => ({ value: String(child.id), label: child.name })), lessons };
    return { origins, syncCursor: JSON.stringify(state), withdrawn };
  }

  return {
    identity: { sourceTypeId: "webuntis", displayName: { en: "WebUntis", de: "WebUntis" }, version: "0.1.0", sdkVersion },
    configuration: {
      version: 1,
      fields: [
        {
          key: "server",
          label: { en: "Server", de: "Server" },
          secret: false,
          required: true,
          description: {
            en: "The school's WebUntis server, such as park.webuntis.com, as the address bar shows it when signed in.",
            de: "Der WebUntis-Server der Schule, etwa park.webuntis.com, wie ihn die Adresszeile nach der Anmeldung zeigt.",
          },
        },
        {
          key: "school",
          label: { en: "School", de: "Schule" },
          secret: false,
          required: true,
          description: {
            en: 'The school\'s name in WebUntis, as "Access through Untis Mobile" in the profile shows it.',
            de: "Der Name der Schule in WebUntis, wie ihn „Zugriff über Untis Mobile“ im Profil zeigt.",
          },
        },
        {
          key: "user",
          label: { en: "User", de: "Benutzer" },
          secret: false,
          required: true,
          description: { en: "The parent account's user name.", de: "Der Benutzername des Elternkontos." },
        },
        {
          key: "secret",
          label: { en: "Key", de: "Schlüssel" },
          secret: true,
          required: true,
          description: {
            en: 'The key under the QR code of "Access through Untis Mobile" in the WebUntis profile. Anyone with it can read the account; generating a new one there revokes it.',
            de: "Der Schlüssel unter dem QR-Code von „Zugriff über Untis Mobile“ im WebUntis-Profil. Wer ihn kennt, kann das Konto lesen; ein dort neu erzeugter Schlüssel widerruft ihn.",
          },
        },
        {
          key: "children",
          label: { en: "Children to read", de: "Zu lesende Kinder" },
          secret: false,
          required: false,
          description: {
            en: "Without a tick, every child of the account is read. Tick one per Source to assign each child's Timetable to its Family Member.",
            de: "Ohne Haken werden alle Kinder des Kontos gelesen. Hake je Quelle eines an, um den Stundenplan jedes Kindes seinem Familienmitglied zuzuordnen.",
          },
          choices: (context) => Promise.resolve(parseState(context.syncCursor).children),
        },
      ],
    },
    setupSteps: [],
    // Gently, as the research in #2 advises: the endpoints are undocumented.
    ingestion: { mode: "polling", suggestedIntervalSeconds: 30 * 60, poll },
    // Holidays bring no new Lessons for weeks.
    health: { silentApplies: false },
  };
}

export default createWebUntisPlugin();

function connectionOf(context: RunContext): { server: string; school: string; user: string } {
  const text = (key: string) => {
    const value = context.config.plain[key];
    return typeof value === "string" ? value.trim() : "";
  };
  // An Admin may paste the address the browser shows rather than the server's name.
  const server = text("server").replace(/^https?:\/\//i, "").replace(/\/.*$/, ""); // eslint-disable-line sonarjs/super-linear-regex -- anchored star at end is O(n)
  const school = text("school");
  const user = text("user");
  if (!/^[a-z0-9.-]+$/i.test(server)) throw SourceError.definite("The WebUntis server is no host name, such as park.webuntis.com.");
  if (school === "" || user === "") throw SourceError.definite("The WebUntis school and user must be given.");
  return { server, school, user };
}

/** The Lessons of a Timetable, which Untis calls periods, with their Timetable Changes, by their ids. */
function seenIn(result: Json, timeZone: string): [string, SeenLesson][] {
  const master = isObject(result.masterData) ? result.masterData : {};
  const named = (list: unknown, name: (entry: Json) => string | null) =>
    new Map(
      (Array.isArray(list) ? list : []).filter(isObject).flatMap((entry) => {
        const value = name(entry);
        return typeof entry.id === "number" && value ? [[entry.id, value] as const] : [];
      }),
    );
  const subjects = named(master.subjects, (subject) => text(subject.longName) ?? text(subject.name));
  const rooms = named(master.rooms, (room) => text(room.name) ?? text(room.longName));
  const teachers = named(master.teachers, (teacher) => {
    const full = [text(teacher.firstName), text(teacher.lastName)].filter(Boolean).join(" ");
    return full || text(teacher.name);
  });
  const timetable = isObject(result.timetable) ? result.timetable : {};
  const periods = (Array.isArray(timetable.periods) ? timetable.periods : []).filter(isObject);
  return periods.flatMap((period): [string, SeenLesson][] => {
    const start = instantOf(period.startDateTime, timeZone);
    const end = instantOf(period.endDateTime, timeZone);
    const elements = (Array.isArray(period.elements) ? period.elements : []).filter(isObject);
    const element = (type: string) => elements.find((candidate) => candidate.type === type);
    /** The element's name now, and before if it was substituted; Untis keeps the original's id as `orgId`. */
    const nameOf = (type: string, names: Map<number, string>) => namesOf(element(type), names);
    const subject = nameOf("SUBJECT", subjects);
    if (typeof period.id !== "number" || !start || !end || end <= start || !subject.name) return [];
    const room = nameOf("ROOM", rooms);
    const teacher = nameOf("TEACHER", teachers);
    const flags = flagsOf(period.is);
    const cancelled = flags.includes("CANCELLED");
    const lesson: Required<LessonFields> = {
      subject: subject.name,
      span: { allDay: false, start: start.toISOString(), end: end.toISOString() },
      room: room.name,
      teacher: teacher.name,
    };
    const kind = cancelled
      ? "cancellation"
      : teacher.previous || subject.previous || flags.includes("SUBSTITUTION")
        ? "substitution"
        : room.previous || flags.includes("ROOM_SUBSTITUTION")
          ? "room-change"
          : null;
    const periodText = isObject(period.text) ? period.text : {};
    const change: Required<TimetableChangeFields> | null = kind
      ? {
          ...lesson,
          change: kind,
          previousRoom: room.previous,
          previousTeacher: teacher.previous,
          note: text(periodText.substitution) ?? text(periodText.info),
        }
      : null;
    return [[String(period.id), { day: localDate(start, timeZone), lesson, cancelled, change }]];
  });
}

/** The element's name now, and before if it was substituted; Untis keeps the original's id as `orgId`. */
function namesOf(found: Json | undefined, names: Map<number, string>): { name: string | null; previous: string | null } {
  const id = numberOf(found?.id);
  // An `orgId` of 0 means the element was not substituted.
  const orgId = numberOf(found?.orgId) || id;
  const nameFor = (key: number | null) => (key === null ? null : (names.get(key) ?? null));
  return { name: nameFor(id), previous: orgId === id ? null : nameFor(orgId) };
}

const numberOf = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** A child of the account, if it has an id. */
function childOf(child: Json): Child[] {
  if (typeof child.id !== "number") return [];
  const name = [child.firstName, child.lastName].filter((part) => typeof part === "string" && part !== "").join(" ");
  return [{ id: child.id, name: name || (text(child.displayName) ?? String(child.id)) }];
}

/** What Untis says a Lesson is, such as `CANCELLED` or `IRREGULAR`, as a list or as flags. */
function flagsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((flag): flag is string => typeof flag === "string").map((flag) => flag.toUpperCase());
  if (isObject(value)) return Object.keys(value).filter((flag) => value[flag] === true).map((flag) => flag.toUpperCase());
  return [];
}

/** What to state about a Lesson, given how the last run saw it. */
function revisionsFor(key: string, before: SeenLesson | undefined, now: SeenLesson): PluginRevision[] {
  const revisions: PluginRevision[] = [];
  if (!before || (before.cancelled && !now.cancelled)) {
    revisions.push(revision("lesson", key, "create", now.lesson));
  } else {
    revisions.push(...changed("lesson", key, before.lesson, now.lesson));
  }
  if (now.cancelled && !before?.cancelled) revisions.push(revision("lesson", key, "cancel", {}));
  revisions.push(...changeRevisions(key, before, now));
  return revisions;
}

/** Revisions for the timetable change attached to a lesson. */
function changeRevisions(key: string, before: SeenLesson | undefined, now: SeenLesson): PluginRevision[] {
  return changeRevisionsOf(`${key}/change`, before?.change ?? undefined, now.change ?? undefined);
}

function changeRevisionsOf(changeKey: string, before: Json | undefined, now: Json | undefined): PluginRevision[] {
  if (now && !before) return [revision("timetable-change", changeKey, "create", now)];
  if (now && before) return changed("timetable-change", changeKey, before, now);
  if (!now && before) return [revision("timetable-change", changeKey, "cancel", {})];
  return [];
}

/** A change or move stating the fields that differ, if any do. */
function changed(kind: PluginRevision["itemKind"], key: string, before: Json, now: Json): PluginRevision[] {
  const fields: Json = {};
  for (const [field, value] of Object.entries(now)) {
    if (JSON.stringify(before[field]) !== JSON.stringify(value)) fields[field] = value;
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) return [];
  return [revision(kind, key, keys.length === 1 && "span" in fields ? "move" : "change", fields)];
}

function revision(itemKind: PluginRevision["itemKind"], itemKey: string, action: PluginRevision["action"], fields: object): PluginRevision {
  return { itemKind, itemKey, action, fields: fields as PluginRevision["fields"] };
}

function parseState(state: string | null): State {
  if (state === null) return { children: [], lessons: {} };
  try {
    const parsed = JSON.parse(state) as Partial<State>;
    return { children: parsed.children ?? [], lessons: parsed.lessons ?? {} };
  } catch {
    return { children: [], lessons: {} };
  }
}

function ticksOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((child): child is string => typeof child === "string") : [];
}

/**
 * The TOTP of RFC 6238 that Untis Mobile sends: six digits from HMAC-SHA1 over 30-second steps of
 * the key in Base32, as a number, as Untis takes it.
 */
function oneTimePassword(key: string, at: Date): number {
  const secret = base32(key);
  if (secret.length === 0) throw SourceError.definite("The WebUntis key is no key in Base32.");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const hash = createHmac("sha1", secret).update(counter).digest();
  const offset = hash.readUInt8(hash.length - 1) & 0x0f;
  return (hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
}

function base32(key: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = key.toUpperCase().replace(/[\s=-]/g, "");
  if (!/^[A-Z2-7]*$/.test(clean)) return Buffer.alloc(0);
  let bits = "";
  for (const char of clean) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => parseInt(byte, 2)));
}

/**
 * The instant of a Lesson's time. Untis Mobile writes the school's wall-clock time with a `Z`, as
 * `2026-09-15T08:00Z`, whatever its offset from UTC, so the time is read in the Family's time zone.
 */
function instantOf(value: unknown, timeZone: string): Date | null {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value) : null;
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      })
        .formatToParts(instant)
        .map((part) => [part.type, Number(part.value)]),
    ) as Record<string, number>;
    return Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day, parts.hour, parts.minute) - instant;
  };
  // The offset at the wall-clock time read as UTC is right except near a change of offset,
  // where the offset at the first guess is.
  const guess = wallClock - offsetAt(wallClock);
  return new Date(wallClock - offsetAt(guess));
}

/** The date an instant shows in a time zone, as `YYYY-MM-DD`. */
function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
