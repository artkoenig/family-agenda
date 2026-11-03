import { randomUUID } from "node:crypto";
import {
  addDays,
  daysBetween,
  dayOfTask,
  eventOf,
  isPinned,
  isAcceptableHorizon,
  isAcceptableTimelineRange,
  lastDayOf,
  localDateTime,
  isShownTo,
  lessonOf,
  spanOnDay,
  taskOf,
  taskStatus,
  timetableChangeOf,
  type Attribution,
  type Event,
  type FamilyLanguage,
  type FamilyMemberId,
  type ItemId,
  type Lesson,
  type LocalDate,
  type LocalTime,
  type MultilingualText,
  type RawMessageId,
  type Task,
  type TaskStatus,
  type TimeSpan,
  type TimetableChange,
  type TimetableChangeKind,
  type Agenda,
  type AgendaId,
  type AgendaKind,
  isAgendaKind,
  type FamilyMember,
} from "@family-agenda/domain";
import type { ActivityLog, CurrentActivity } from "./activity";
import { concernsOf } from "./assignment";
import { summariseFamilyMember, type FamilyMemberSummary } from "./family-members";
import type {
  Clock,
  FamilyMemberRepository,
  FamilyRepository,
  InstalledSourceType,
  ItemRepository,
  ProjectedItem,
  SourceRepository,
  SourceTypeRegistry,
  AgendaAccessPolicy,
  AgendaRepository,
} from "./ports";
import type { SourceHealthCheck } from "./source-health";

export type AgendasDeps = {
  clock: Clock;
  /** The IANA time zone the Family lives in, which decides where a day starts. */
  timeZone: string;
  families: FamilyRepository;
  members: FamilyMemberRepository;
  agendas: AgendaRepository;
  items: ItemRepository;
  sources: SourceRepository;
  registry: SourceTypeRegistry;
  activity: ActivityLog;
  sourceHealth: SourceHealthCheck;
};

export type AgendaSettings = { kind: AgendaKind; preselected: FamilyMemberId[]; horizonDays: number };

/** The settings as an Admin enters them; without a kind, a new Agenda is a timeline and an edited one keeps its own. */
export type AgendaSettingsInput = Omit<AgendaSettings, "kind"> & { kind?: string };

export type AgendaSummary = AgendaSettings & { id: AgendaId };

export type AgendaProblem = "unknown-kind" | "invalid-horizon" | "unknown-member";

/** Whom the quick filter shows: some Family Members, or everyone. */
export type Showing = FamilyMemberId[] | "all";

/** A date and time on the Family's clocks. */
export type LocalDateTime = { date: LocalDate; time: LocalTime };

/** An Event as one row of a day, shown while the quick filter shows someone it concerns. */
export type TimelineEvent = {
  itemId: ItemId;
  title: string;
  /** When it starts on this day; null if it is all day or started on an earlier day. */
  from: LocalTime | null;
  /** When it ends on this day; null if it is all day or ends on a later day. */
  until: LocalTime | null;
  /** The whole span, for the details. */
  span: { allDay: true; firstDay: LocalDate; lastDay: LocalDate } | { allDay: false; start: LocalDateTime; end: LocalDateTime };
  place: string | null;
  /** Cancelled Events stay on the timeline, struck through, until their date has passed. */
  cancelled: boolean;
  /** Over before now; earlier rows of today are dimmed. */
  earlier: boolean;
  /** Where the original can be looked at, each with its Source's name, else its Source Type's. */
  links: { url: string; source: MultilingualText }[];
  /** The raw messages it was extracted from, which Admins can open, each with its Source's name, else its Source Type's. */
  messages: { id: RawMessageId; source: MultilingualText }[];
  /** Whom it concerns, by the Family Members its Sources are assigned to, the Family Members in the Family's order. */
  concerns: Attribution;
};

/** A Lesson as a school-day row lists it on tap. */
export type TimelineLesson = {
  itemId: ItemId;
  subject: string;
  from: LocalTime;
  until: LocalTime;
  room: string | null;
  teacher: string | null;
  cancelled: boolean;
};

/**
 * The Lessons of one day that concern the same Family Members, as one row: "School until hh:mm".
 * It runs from the first to the last Lesson that takes place, or over all of them if every one is
 * cancelled, which cancels the day.
 */
export type TimelineSchoolDay = {
  from: LocalTime;
  until: LocalTime;
  /** Every Lesson of the day is cancelled. */
  cancelled: boolean;
  /** The day has a Timetable Change. */
  changed: boolean;
  /** Over before now; earlier rows of today are dimmed. */
  earlier: boolean;
  /** In order of time, cancelled ones included. */
  lessons: TimelineLesson[];
  concerns: Attribution;
};

/** A Timetable Change as its own highlighted row; one the school withdrew is gone. */
export type TimelineTimetableChange = {
  itemId: ItemId;
  change: TimetableChangeKind;
  subject: string;
  from: LocalTime;
  until: LocalTime;
  room: string | null;
  teacher: string | null;
  previousRoom: string | null;
  previousTeacher: string | null;
  note: string | null;
  earlier: boolean;
  concerns: Attribution;
};

/**
 * A Task as an Agenda shows it: pinned at the top while it is Due, else on its day, checked and dimmed
 * once done; anyone with the Agenda can tick it done or take the tick back.
 */
export type TimelineTask = {
  itemId: ItemId;
  title: string;
  deadline: LocalDate | null;
  bring: string[];
  status: TaskStatus;
  /** Struck through, wherever it shows. */
  cancelled: boolean;
  links: TimelineEvent["links"];
  messages: TimelineEvent["messages"];
  concerns: Attribution;
};

/** What an Agenda's top bar shows, whatever its kind. */
type AgendaBarPage = {
  id: AgendaId;
  /** The Family Language, which dates are formatted in. */
  language: FamilyLanguage;
  now: LocalDateTime;
  /** Everyone in the Family, for the avatars of whom an Event concerns. */
  members: FamilyMemberSummary[];
  /**
   * Whom the quick filter offers: those the Agenda preselects, or everyone if it preselects no one.
   * With only one, there is nothing to filter.
   */
  choices: FamilyMemberSummary[];
  /** Whom the Agenda shows, always some of `choices`, or "all" if the Agenda preselects no one. */
  showing: Showing;
  /** What the worker is busy with, such as reading messages; null when it is idle. */
  activity: CurrentActivity | null;
  /** Whether a Source is Failing, which the Agenda says without naming it. */
  mayBeOutOfDate: boolean;
};

/** An Agenda of the timeline kind, as it shows its days. */
export type AgendaPage = AgendaBarPage & {
  kind: "timeline";
  /** How many days one step of scrolling loads: the Agenda's horizon. */
  horizonDays: number;
  /** The Tasks Due or Overdue that concern someone it shows, oldest Deadline first, those without one last. */
  pinned: TimelineTask[];
  /**
   * One per day shown, the horizon from today or the days scrolled to, each with its Events, its
   * school days and its Timetable Changes, each in order of time.
   */
  days: TimelineDay[];
};

/**
 * A Task List: the Tasks that concern someone it shows, Due and Overdue ones first, then those
 * not Due yet, then those done, of the last 30 days and all of the future.
 */
export type TaskListPage = AgendaBarPage & {
  kind: "tasks";
  /** Those pinned in a timeline, oldest Deadline first, those without one last. */
  due: TimelineTask[];
  /** Those not Due yet, by Deadline. */
  upcoming: TimelineTask[];
  /** Those ticked done, by Deadline. */
  done: TimelineTask[];
};

export type TimelineDay = {
  date: LocalDate;
  items: TimelineEvent[];
  /** The Tasks on the day that are not pinned: not Due yet, or done. */
  tasks: TimelineTask[];
  schoolDays: TimelineSchoolDay[];
  timetableChanges: TimelineTimetableChange[];
};

/** Days of a timeline, from `first` to `last`, both included. */
export type TimelineDays = { first: LocalDate; last: LocalDate };

/** An Event in an Agenda's feed, which carries those concerning someone its Agenda preselects. */
export type FeedEvent = {
  itemId: ItemId;
  title: string;
  span: TimeSpan;
  /** The span on the Family's clocks, for the details. */
  when: TimelineEvent["span"];
  place: string | null;
  cancelled: boolean;
};

/**
 * One school day of some Family Members in an Agenda's feed, an all-day entry in place of its
 * Lessons, which its details list with the day's Timetable Changes.
 */
export type FeedSchoolDay = {
  /** Stays the same while the day concerns the same Family Members, so that apps update it in place. */
  key: string;
  date: LocalDate;
  /** Every Lesson of the day is cancelled. */
  cancelled: boolean;
  lessons: TimelineLesson[];
  timetableChanges: TimelineTimetableChange[];
  concerns: Attribution;
  /**
   * The names of the Family Members it concerns, for its title, in the Family's order: none if it
   * concerns the whole Family, or if the feed is for one Family Member only.
   */
  names: string[];
};

/** An undone Task with a Deadline in an Agenda's feed, as an all-day entry on its Deadline day. */
export type FeedTask = {
  itemId: ItemId;
  title: string;
  deadline: LocalDate;
  bring: string[];
  overdue: boolean;
  cancelled: boolean;
};

export type AgendaFeed = {
  id: AgendaId;
  /** The Family Language, which the details' dates are formatted in. */
  language: FamilyLanguage;
  generatedAt: Date;
  /** Those of the last 30 days and all of the future, in order of time. */
  events: FeedEvent[];
  /** Those of the last 30 days and all of the future, by day. */
  schoolDays: FeedSchoolDay[];
  /** Those not done whose Deadline is in the last 30 days or the future, by Deadline. */
  tasks: FeedTask[];
};

/** How many days back a feed reaches, today not counted. */
const feedDaysBack = 30;

/** How many days back a Task List reaches for Tasks that are done, today not counted. */
const taskListDaysBack = 30;

/** Lets every Agenda open, as on the local listener (ADR-0003). */
export const openAgendaAccess: AgendaAccessPolicy = { mayOpen: () => Promise.resolve(true) };

export function createAgendaAccess(deps: AgendasDeps) {
  const { clock, timeZone, families, members, agendas, items, sources, registry, activity, sourceHealth } = deps;

  /**
   * The name an Admin gave the Source, else the display name of its Source Type, or that type's id
   * if it is not installed.
   */
  function sourceName(origin: { sourceTypeId: string; sourceName: string | null }, installed: InstalledSourceType[]): MultilingualText {
    return origin.sourceName ?? installed.find((type) => type.id === origin.sourceTypeId)?.displayName ?? origin.sourceTypeId;
  }

  /**
   * The Family's Items that may touch the days from `first` to `last`, or all later days if
   * `last` is null, that concern someone `showing` shows, as Events, Lessons and Timetable
   * Changes; the caller decides by the Family's time zone. Whom its Sources are assigned to now
   * decides whom an Item concerns, whenever it came.
   */
  async function itemsAround(first: LocalDate, last: LocalDate | null, showing: Showing) {
    // A day lasts at most 26 hours, and no time zone is more than 14 hours from UTC.
    const day = 24 * 60 * 60 * 1000;
    const from = new Date(new Date(`${first}T00:00:00Z`).getTime() - day);
    const to = last ? new Date(new Date(`${addDays(last, 1)}T00:00:00Z`).getTime() + day) : null;
    const known = await sources.list();
    const order = (await members.list()).map((member) => member.id);
    const installed = registry.installed();
    const found: Around = { events: [], lessons: [], changes: [], tasks: [] };
    const overlapping = await items.overlapping(from, to);
    const seen = new Set(overlapping.map((item) => item.id));
    // An undone Task stays pinned, whatever its Deadline.
    const outstanding = (await items.outstanding()).filter((item) => !seen.has(item.id));
    for (const item of [...overlapping, ...outstanding]) {
      const attribution = concernsOf(item, known);
      if (showing !== "all" && !isShownTo(attribution, showing)) continue;
      const concerns = attribution === "whole-family" ? attribution : order.filter((id) => attribution.includes(id));
      const links = item.links.map((link) => ({ url: link.url, source: sourceName(link, installed) }));
      const messages = item.messages.map((message) => ({ id: message.id, source: sourceName(message, installed) }));
      classifyItem(item, found, links, messages, concerns);
    }
    return found;
  }

  function classifyItem(
    item: ProjectedItem,
    found: Around,
    links: TimelineEvent["links"],
    messages: TimelineEvent["messages"],
    concerns: Attribution,
  ): void {
    if (item.kind === "event") classifyEvent(item, found, links, messages, concerns);
    else if (item.kind === "task") classifyTask(item, found, links, messages, concerns);
    else if (item.kind === "lesson") classifyLesson(item, found, concerns);
    else if (item.kind === "timetable-change") classifyChange(item, found, concerns);
  }

  function classifyEvent(item: ProjectedItem, found: Around, links: TimelineEvent["links"], messages: TimelineEvent["messages"], concerns: Attribution): void {
    const event = eventOf(item.folded);
    if (event) found.events.push({ id: item.id, event, links, messages, concerns });
  }

  function classifyTask(item: ProjectedItem, found: Around, links: TimelineEvent["links"], messages: TimelineEvent["messages"], concerns: Attribution): void {
    const task = taskOf(item.folded);
    if (task) found.tasks.push({ id: item.id, task, links, messages, concerns });
  }

  function classifyLesson(item: ProjectedItem, found: Around, concerns: Attribution): void {
    const lesson = lessonOf(item.folded);
    if (lesson) found.lessons.push({ id: item.id, lesson, concerns });
  }

  function classifyChange(item: ProjectedItem, found: Around, concerns: Attribution): void {
    const change = timetableChangeOf(item.folded);
    if (change && !change.cancelled) found.changes.push({ id: item.id, change, concerns });
  }

  function taskRow(found: Around["tasks"][number], today: LocalDate): TimelineTask {
    const { id, task, links, messages, concerns } = found;
    const { title, deadline, bring, cancelled } = task;
    return { itemId: id, title, deadline, bring, status: taskStatus(task, today), cancelled, links, messages, concerns };
  }

  /** The Lesson on the Family's clocks. */
  function lessonRow(id: ItemId, lesson: Lesson): TimelineLesson {
    const { subject, room, teacher, cancelled } = lesson;
    return { itemId: id, subject, ...clockTimes(lesson.span), room, teacher, cancelled };
  }

  function changeRow(id: ItemId, change: TimetableChange, concerns: Attribution, now: Date): TimelineTimetableChange {
    const { change: kind, subject, room, teacher, previousRoom, previousTeacher, note, span } = change;
    return {
      itemId: id,
      change: kind,
      subject,
      ...clockTimes(span),
      room,
      teacher,
      previousRoom,
      previousTeacher,
      note,
      earlier: span.end <= now,
      concerns,
    };
  }

  function clockTimes(span: { start: Date; end: Date }): { from: LocalTime; until: LocalTime } {
    return { from: localDateTime(span.start, timeZone).time, until: localDateTime(span.end, timeZone).time };
  }

  /** The day a Lesson or Timetable Change is on, by when it starts. */
  function dayOf(span: { start: Date }): LocalDate {
    return localDateTime(span.start, timeZone).date;
  }

  /**
   * The Lessons of a day as school days, one per set of Family Members they concern, with the
   * day's Timetable Changes of the same Family Members.
   */
  function schoolDaysOn(date: LocalDate, around: Around, now: Date) {
    const days = new Map<string, { concerns: Attribution; lessons: { lesson: Lesson; row: TimelineLesson }[]; changes: TimelineTimetableChange[] }>();
    const dayFor = (concerns: Attribution) => {
      const key = concernsKey(concerns);
      const found = days.get(key) ?? { concerns, lessons: [], changes: [] };
      days.set(key, found);
      return found;
    };
    for (const { id, lesson, concerns } of around.lessons) {
      if (dayOf(lesson.span) === date) dayFor(concerns).lessons.push({ lesson, row: lessonRow(id, lesson) });
    }
    const changes = around.changes
      .filter(({ change }) => dayOf(change.span) === date)
      .map(({ id, change, concerns }) => changeRow(id, change, concerns, now))
      .sort(byFrom);
    for (const change of changes) days.get(concernsKey(change.concerns))?.changes.push(change);
    const schoolDays = [...days.entries()].flatMap(([key, day]) => {
      const lessons = day.lessons.toSorted((a, b) => a.lesson.span.start.getTime() - b.lesson.span.start.getTime());
      const takingPlace = lessons.filter(({ lesson }) => !lesson.cancelled);
      const spanned = takingPlace.length > 0 ? takingPlace : lessons;
      const first = spanned[0];
      if (!first) return [];
      const start = first.lesson.span.start;
      const end = new Date(Math.max(...spanned.map(({ lesson }) => lesson.span.end.getTime())));
      return [
        {
          key,
          school: {
            ...clockTimes({ start, end }),
            cancelled: takingPlace.length === 0,
            changed: day.changes.length > 0,
            earlier: end <= now,
            lessons: lessons.map(({ row }) => row),
            concerns: day.concerns,
          } satisfies TimelineSchoolDay,
          changes: day.changes,
        },
      ];
    });
    return { schoolDays, changes };
  }

  /** The Family's Events on each of the days that concern someone `showing` shows, in order of time. */
  async function timelineOf(
    dates: LocalDate[],
    showing: Showing,
    now: Date,
  ): Promise<Pick<AgendaPage, "pinned" | "days">> {
    const first = dates[0];
    const last = dates.at(-1);
    if (!first || !last) return { pinned: [], days: [] };
    const around = await itemsAround(first, last, showing);
    const today = localDateTime(now, timeZone).date;
    const pinned = around.tasks
      .filter(({ task }) => isPinned(task, today))
      .map((found) => taskRow(found, today))
      .sort(byDeadline);
    const unpinned = around.tasks.filter(({ task }) => !isPinned(task, today));
    const days = dates.map((date) => {
      const { schoolDays, changes } = schoolDaysOn(date, around, now);
      return {
        date,
        tasks: unpinned
          .filter(({ task }) => dayOfTask(task, timeZone) === date)
          .map((found) => taskRow(found, today))
          .sort((a, b) => a.title.localeCompare(b.title)),
        items: around.events
          .flatMap(({ id, event, links, messages, concerns }) => {
            const on = spanOnDay(event.span, date, timeZone);
            return on ? [row(id, event, { links, messages, concerns }, on, now)] : [];
          })
          .sort(byTime),
        schoolDays: schoolDays.map(({ school }) => school).sort(byFrom),
        timetableChanges: changes,
      };
    });
    return { pinned, days };
  }

  /** The Tasks of a Task List that concern someone `showing` shows, by whether they are Due, not yet, or done. */
  async function taskListOf(today: LocalDate, showing: Showing): Promise<Pick<TaskListPage, "due" | "upcoming" | "done">> {
    const around = await itemsAround(addDays(today, -taskListDaysBack), null, showing);
    const rows = around.tasks.map((found) => ({ pinned: isPinned(found.task, today), row: taskRow(found, today) }));
    return {
      due: rows.filter(({ pinned }) => pinned).map(({ row }) => row).sort(byDeadline),
      upcoming: rows.filter(({ pinned, row }) => !pinned && row.status !== "done").map(({ row }) => row).sort(byDeadline),
      done: rows.filter(({ pinned, row }) => !pinned && row.status === "done").map(({ row }) => row).sort(byDeadline),
    };
  }

  function row(
    itemId: ItemId,
    event: Event,
    originals: Pick<TimelineEvent, "links" | "messages" | "concerns">,
    on: { from: LocalTime | null; until: LocalTime | null },
    now: Date,
  ): TimelineEvent {
    const { span } = event;
    return {
      itemId,
      title: event.title,
      ...on,
      span: onClocks(span),
      place: event.place,
      cancelled: event.cancelled,
      earlier: !span.allDay && span.end <= now,
      ...originals,
    };
  }

  function onClocks(span: TimeSpan): TimelineEvent["span"] {
    return span.allDay
      ? span
      : { allDay: false, start: localDateTime(span.start, timeZone), end: localDateTime(span.end, timeZone) };
  }

  /** The settings with the preselected Family Members in the Family's order, or a problem. */
  async function checkSettings(
    settings: AgendaSettingsInput,
    defaultKind: AgendaKind,
  ): Promise<{ ok: true; settings: AgendaSettings } | { ok: false; problem: AgendaProblem }> {
    const kind = settings.kind ?? defaultKind;
    if (!isAgendaKind(kind)) return { ok: false, problem: "unknown-kind" };
    if (!isAcceptableHorizon(settings.horizonDays)) return { ok: false, problem: "invalid-horizon" };
    const known = (await members.list()).map((member) => member.id);
    if (!settings.preselected.every((id) => known.includes(id))) {
      return { ok: false, problem: "unknown-member" };
    }
    const preselected = known.filter((id) => settings.preselected.includes(id));
    return { ok: true, settings: { kind, preselected, horizonDays: settings.horizonDays } };
  }

  function resolveShowing(show: Showing | undefined, choices: { id: FamilyMemberId }[], preselected: FamilyMemberId[]): Showing {
    const resolved = show ?? "all";
    const chosen = resolved === "all" ? [] : choices.map((member) => member.id).filter((memberId) => resolved.includes(memberId));
    return chosen.length > 0 ? chosen : preselected.length > 0 ? choices.map((member) => member.id) : "all";
  }

  async function barOf(agenda: Agenda, family: FamilyMember[], choices: FamilyMember[], showing: Showing, instant: Date): Promise<AgendaBarPage> {
    const now = localDateTime(instant, timeZone);
    return {
      id: agenda.id,
      language: (await families.languages()).language,
      now,
      members: family.map(summariseFamilyMember),
      choices: choices.map(summariseFamilyMember),
      showing,
      activity: await activity.current(),
      mayBeOutOfDate: await sourceHealth.anyFailing(),
    };
  }

  function timelineDates(days: TimelineDays | undefined, today: LocalDate, horizonDays: number): LocalDate[] {
    const { first, last } = days ?? { first: today, last: addDays(today, horizonDays - 1) };
    return Array.from({ length: daysBetween(first, last) + 1 }, (_, day) => addDays(first, day));
  }



  return {
    async list(): Promise<AgendaSummary[]> {
      const all = await agendas.list();
      return all.map(({ id, kind, preselected, horizonDays }) => ({ id, kind, preselected, horizonDays }));
    },

    async create(
      input: AgendaSettingsInput,
    ): Promise<{ ok: true; id: AgendaId } | { ok: false; problem: AgendaProblem }> {
      const checked = await checkSettings(input, "timeline");
      if (!checked.ok) return checked;
      const id = randomUUID() as AgendaId;
      await agendas.add({
        id,
        ...checked.settings,
        createdAt: clock.now(),
      });
      return { ok: true, id };
    },

    async edit(
      id: AgendaId,
      input: AgendaSettingsInput,
    ): Promise<{ ok: true } | { ok: false; problem: AgendaProblem | "unknown-agenda" }> {
      const agenda = await agendas.findById(id);
      if (!agenda) return { ok: false, problem: "unknown-agenda" };
      const checked = await checkSettings(input, agenda.kind);
      if (!checked.ok) return checked;
      await agendas.update({ ...agenda, ...checked.settings });
      return { ok: true };
    },

    async remove(id: AgendaId): Promise<void> {
      await agendas.remove(id);
    },

    /**
     * The Agenda as its timeline or its Task List, by its kind, or null if there is no such Agenda or
     * `access` refuses it. `show` is what the quick filter was set to, of those the Agenda
     * preselects; without it, or with none of them, it shows all of them, or everyone if the Agenda
     * preselects no one. `days` are those a timeline scrolled to, into the past or the future;
     * without them, it shows the horizon from today. They must pass `isAcceptableTimelineRange`,
     * and a Task List leaves them aside.
     */
    async open(
      id: AgendaId,
      input: { access: AgendaAccessPolicy; show?: Showing; days?: TimelineDays },
    ): Promise<AgendaPage | TaskListPage | null> {
      if (input.days && !isAcceptableTimelineRange(input.days.first, input.days.last)) {
        throw new Error(`unacceptable timeline days ${input.days.first} to ${input.days.last}`);
      }
      const agenda = await agendas.findById(id);
      if (!agenda || !(await input.access.mayOpen(agenda.id))) return null;
      const family = await members.list();
      const choices = agenda.preselected.length > 0 ? family.filter((member) => agenda.preselected.includes(member.id)) : family;
      const showing = resolveShowing(input.show, choices, agenda.preselected);
      const instant = clock.now();
      const bar = await barOf(agenda, family, choices, showing, instant);
      const now = localDateTime(instant, timeZone);
      if (agenda.kind === "tasks") return { ...bar, kind: "tasks", ...(await taskListOf(now.date, showing)) };
      const dates = timelineDates(input.days, now.date, agenda.horizonDays);
      return { ...bar, kind: "timeline", horizonDays: agenda.horizonDays, ...(await timelineOf(dates, showing, instant)) };
    },

    /**
     * What the worker is busy with, for an Agenda to show while it is; undefined if there is no
     * such Agenda or `access` refuses it.
     */
    async activity(id: AgendaId, input: { access: AgendaAccessPolicy }): Promise<CurrentActivity | null | undefined> {
      const agenda = await agendas.findById(id);
      if (!agenda || !(await input.access.mayOpen(agenda.id))) return undefined;
      return activity.current();
    },

    /**
     * The Agenda as a calendar feed, or null if there is no such Agenda or `access` refuses it: the
     * Events, school days and undone Tasks of the last 30 days and all of the future, cancelled
     * ones included, whatever the Agenda's horizon, that concern someone the Agenda preselects, or all if it preselects no one.
     */
    async feed(id: AgendaId, input: { access: AgendaAccessPolicy }): Promise<AgendaFeed | null> {
      const agenda = await agendas.findById(id);
      if (!agenda || !(await input.access.mayOpen(agenda.id))) return null;
      const generatedAt = clock.now();
      const firstDay = addDays(localDateTime(generatedAt, timeZone).date, -feedDaysBack);
      const showing: Showing = agenda.preselected.length > 0 ? agenda.preselected : "all";
      const around = await itemsAround(firstDay, null, showing);
      const events = around.events.flatMap(({ id: itemId, event }) => {
        if (lastDayOf(event.span, timeZone) < firstDay) return [];
        const { title, span, place, cancelled } = event;
        return [{ itemId, title, span, when: onClocks(span), place, cancelled }];
      });
      const family = await members.list();
      const named = (concerns: Attribution) =>
        concerns === "whole-family" || agenda.preselected.length === 1 ? [] : family.filter((member) => concerns.includes(member.id));
      const dates = [...new Set(around.lessons.map(({ lesson }) => dayOf(lesson.span)))].filter((date) => date >= firstDay).sort();
      const schoolDays = dates.flatMap((date) =>
        schoolDaysOn(date, around, generatedAt)
          .schoolDays.map(({ key, school, changes }) => ({
            key: `${date}/${key}`,
            date,
            cancelled: school.cancelled,
            lessons: school.lessons,
            timetableChanges: changes,
            concerns: school.concerns,
            names: named(school.concerns).map((member) => member.name),
          }))
          .sort((a, b) => firstIn(family, a.concerns) - firstIn(family, b.concerns)),
      );
      const today = addDays(firstDay, feedDaysBack);
      const tasks = around.tasks.flatMap(({ id: itemId, task }) => {
        const { title, deadline, bring, cancelled } = task;
        if (deadline === null || deadline < firstDay || task.doneAt) return [];
        return [{ itemId, title, deadline, bring, overdue: taskStatus(task, today) === "overdue", cancelled }];
      });
      const sortedTasks = tasks.toSorted((a, b) => a.deadline.localeCompare(b.deadline) || a.title.localeCompare(b.title));
      const { language } = await families.languages();
      return { id: agenda.id, language, generatedAt, events: events.toSorted(byStart), schoolDays, tasks: sortedTasks };
    },
  };
}

export type AgendaAccess = ReturnType<typeof createAgendaAccess>;

/** The Items around some days, by kind, each with whom it concerns. */
type Around = {
  events: { id: ItemId; event: Event; links: TimelineEvent["links"]; messages: TimelineEvent["messages"]; concerns: Attribution }[];
  lessons: { id: ItemId; lesson: Lesson; concerns: Attribution }[];
  /** Those the school withdrew are left out. */
  changes: { id: ItemId; change: TimetableChange; concerns: Attribution }[];
  tasks: { id: ItemId; task: Task; links: TimelineEvent["links"]; messages: TimelineEvent["messages"]; concerns: Attribution }[];
};

/** The same for the same Family Members, whatever their order. */
function concernsKey(concerns: Attribution): string {
  return concerns === "whole-family" ? concerns : [...concerns].sort().join(",");
}

/** Where the first Family Member concerned stands in the Family's order; the whole Family comes first. */
function firstIn(family: { id: FamilyMemberId }[], concerns: Attribution): number {
  return concerns === "whole-family" ? -1 : family.findIndex((member) => concerns.includes(member.id));
}

/** By their Deadline, the oldest first, and those without one last. */
function byDeadline(a: TimelineTask, b: TimelineTask): number {
  return (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || a.title.localeCompare(b.title);
}

function byFrom(a: { from: LocalTime }, b: { from: LocalTime }): number {
  return a.from.localeCompare(b.from);
}

/** All-day rows first, then by the time they start on the day, earliest first. */
function byTime(a: TimelineEvent, b: TimelineEvent): number {
  const key = (row: TimelineEvent) => (row.span.allDay ? "" : (row.from ?? "00:00"));
  return key(a).localeCompare(key(b)) || a.title.localeCompare(b.title);
}

/** By the day and time they start, all-day ones first on their day. */
function byStart(a: FeedEvent, b: FeedEvent): number {
  const key = ({ when }: FeedEvent) => (when.allDay ? when.firstDay : `${when.start.date} ${when.start.time}`);
  return key(a).localeCompare(key(b)) || a.title.localeCompare(b.title);
}
