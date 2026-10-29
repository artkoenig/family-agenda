import { randomUUID } from "node:crypto";
import {
  addDays,
  attributionOf,
  daysBetween,
  eventOf,
  isAcceptableHorizon,
  isAcceptableTimelineRange,
  lastDayOf,
  localDateTime,
  isShownTo,
  lessonOf,
  spanOnDay,
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
  type TimeSpan,
  type TimetableChange,
  type TimetableChangeKind,
  type ViewId,
} from "@family-agenda/domain";
import type { ActivityLog, CurrentActivity } from "./activity";
import { summariseFamilyMember, type FamilyMemberSummary } from "./family-members";
import type {
  Clock,
  FamilyMemberRepository,
  FamilyRepository,
  InstalledSourceType,
  ItemRepository,
  SourceRepository,
  SourceTypeRegistry,
  ViewAccessPolicy,
  ViewRepository,
} from "./ports";
import type { SourceHealthCheck } from "./source-health";

export type ViewsDeps = {
  clock: Clock;
  /** The IANA time zone the Family lives in, which decides where a day starts. */
  timeZone: string;
  families: FamilyRepository;
  members: FamilyMemberRepository;
  views: ViewRepository;
  items: ItemRepository;
  sources: SourceRepository;
  registry: SourceTypeRegistry;
  activity: ActivityLog;
  sourceHealth: SourceHealthCheck;
};

export type ViewSettings = { preselected: FamilyMemberId[]; horizonDays: number };

export type ViewSummary = ViewSettings & { id: ViewId };

export type ViewProblem = "invalid-horizon" | "unknown-member";

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

export type ViewPage = {
  id: ViewId;
  /** The Family Language, which dates are formatted in. */
  language: FamilyLanguage;
  now: LocalDateTime;
  /** Everyone in the Family, for the avatars of whom an Event concerns. */
  members: FamilyMemberSummary[];
  /**
   * Whom the quick filter offers: those the View preselects, or everyone if it preselects no one.
   * With only one, there is nothing to filter.
   */
  choices: FamilyMemberSummary[];
  /** Whom the timeline shows, always some of `choices`, or "all" if the View preselects no one. */
  showing: Showing;
  /** How many days one step of scrolling loads: the View's horizon. */
  horizonDays: number;
  /**
   * One per day shown, the horizon from today or the days scrolled to, each with its Events, its
   * school days and its Timetable Changes, each in order of time.
   */
  days: TimelineDay[];
  /** What the worker is busy with, such as reading messages; null when it is idle. */
  activity: CurrentActivity | null;
  /** Whether a Source is Failing, which the View says without naming it. */
  mayBeOutOfDate: boolean;
};

export type TimelineDay = {
  date: LocalDate;
  items: TimelineEvent[];
  schoolDays: TimelineSchoolDay[];
  timetableChanges: TimelineTimetableChange[];
};

/** Days of a timeline, from `first` to `last`, both included. */
export type TimelineDays = { first: LocalDate; last: LocalDate };

/** An Event in a View's feed, which carries those concerning someone its View preselects. */
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
 * One school day of some Family Members in a View's feed, an all-day entry in place of its
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

export type ViewFeed = {
  id: ViewId;
  /** The Family Language, which the details' dates are formatted in. */
  language: FamilyLanguage;
  generatedAt: Date;
  /** Those of the last 30 days and all of the future, in order of time. */
  events: FeedEvent[];
  /** Those of the last 30 days and all of the future, by day. */
  schoolDays: FeedSchoolDay[];
};

/** How many days back a feed reaches, today not counted. */
const feedDaysBack = 30;

/** Lets every View open, as on the local listener (ADR-0003). */
export const openViewAccess: ViewAccessPolicy = { mayOpen: () => Promise.resolve(true) };

export function createViewAccess(deps: ViewsDeps) {
  const { clock, timeZone, families, members, views, items, sources, registry, activity, sourceHealth } = deps;

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
    const assigned = new Map((await sources.list()).map((source) => [source.id, source.concerns]));
    const order = (await members.list()).map((member) => member.id);
    const installed = registry.installed();
    const found: Around = { events: [], lessons: [], changes: [] };
    for (const item of await items.overlapping(from, to)) {
      const attribution = attributionOf(item.sourceIds.map((id) => assigned.get(id) ?? []));
      if (showing !== "all" && !isShownTo(attribution, showing)) continue;
      const concerns = attribution === "whole-family" ? attribution : order.filter((id) => attribution.includes(id));
      if (item.kind === "event") {
        const event = eventOf(item.folded);
        if (!event) continue;
        const links = item.links.map((link) => ({ url: link.url, source: sourceName(link, installed) }));
        const messages = item.messages.map((message) => ({ id: message.id, source: sourceName(message, installed) }));
        found.events.push({ id: item.id, event, links, messages, concerns });
      } else if (item.kind === "lesson") {
        const lesson = lessonOf(item.folded);
        if (lesson) found.lessons.push({ id: item.id, lesson, concerns });
      } else if (item.kind === "timetable-change") {
        const change = timetableChangeOf(item.folded);
        if (change && !change.cancelled) found.changes.push({ id: item.id, change, concerns });
      }
    }
    return found;
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
      const lessons = day.lessons.sort((a, b) => a.lesson.span.start.getTime() - b.lesson.span.start.getTime());
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
  ): Promise<ViewPage["days"]> {
    const first = dates[0];
    const last = dates.at(-1);
    if (!first || !last) return [];
    const around = await itemsAround(first, last, showing);
    return dates.map((date) => {
      const { schoolDays, changes } = schoolDaysOn(date, around, now);
      return {
        date,
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
    settings: ViewSettings,
  ): Promise<{ ok: true; settings: ViewSettings } | { ok: false; problem: ViewProblem }> {
    if (!isAcceptableHorizon(settings.horizonDays)) return { ok: false, problem: "invalid-horizon" };
    const known = (await members.list()).map((member) => member.id);
    if (!settings.preselected.every((id) => known.includes(id))) {
      return { ok: false, problem: "unknown-member" };
    }
    const preselected = known.filter((id) => settings.preselected.includes(id));
    return { ok: true, settings: { preselected, horizonDays: settings.horizonDays } };
  }

  return {
    async list(): Promise<ViewSummary[]> {
      const all = await views.list();
      return all.map(({ id, preselected, horizonDays }) => ({ id, preselected, horizonDays }));
    },

    async create(
      input: ViewSettings,
    ): Promise<{ ok: true; id: ViewId } | { ok: false; problem: ViewProblem }> {
      const checked = await checkSettings(input);
      if (!checked.ok) return checked;
      const id = randomUUID() as ViewId;
      await views.add({
        id,
        ...checked.settings,
        createdAt: clock.now(),
      });
      return { ok: true, id };
    },

    async edit(
      id: ViewId,
      input: ViewSettings,
    ): Promise<{ ok: true } | { ok: false; problem: ViewProblem | "unknown-view" }> {
      const view = await views.findById(id);
      if (!view) return { ok: false, problem: "unknown-view" };
      const checked = await checkSettings(input);
      if (!checked.ok) return checked;
      await views.update({ ...view, ...checked.settings });
      return { ok: true };
    },

    async remove(id: ViewId): Promise<void> {
      await views.remove(id);
    },

    /**
     * The View as its timeline, or null if there is no such View or `access` refuses it.
     * `show` is what the quick filter was set to, of those the View preselects; without it, or
     * with none of them, it shows all of them, or everyone if the View preselects no one.
     * `days` are those scrolled to, into the past or the future; without them, it shows the
     * horizon from today. They must pass `isAcceptableTimelineRange`.
     */
    async open(
      id: ViewId,
      input: { access: ViewAccessPolicy; show?: Showing; days?: TimelineDays },
    ): Promise<ViewPage | null> {
      if (input.days && !isAcceptableTimelineRange(input.days.first, input.days.last)) {
        throw new Error(`unacceptable timeline days ${input.days.first} to ${input.days.last}`);
      }
      const view = await views.findById(id);
      if (!view || !(await input.access.mayOpen(view.id))) return null;
      const family = await members.list();
      const choices = view.preselected.length > 0 ? family.filter((member) => view.preselected.includes(member.id)) : family;
      const show = input.show ?? "all";
      const chosen = show === "all" ? [] : choices.map((member) => member.id).filter((memberId) => show.includes(memberId));
      const showing: Showing =
        chosen.length > 0 ? chosen : view.preselected.length > 0 ? choices.map((member) => member.id) : "all";
      const instant = clock.now();
      const now = localDateTime(instant, timeZone);
      const { first, last } = input.days ?? { first: now.date, last: addDays(now.date, view.horizonDays - 1) };
      const dates = Array.from({ length: daysBetween(first, last) + 1 }, (_, day) => addDays(first, day));
      return {
        id: view.id,
        language: (await families.languages()).language,
        now,
        members: family.map(summariseFamilyMember),
        choices: choices.map(summariseFamilyMember),
        showing,
        horizonDays: view.horizonDays,
        days: await timelineOf(dates, showing, instant),
        activity: await activity.current(),
        mayBeOutOfDate: await sourceHealth.anyFailing(),
      };
    },

    /**
     * What the worker is busy with, for a View to show while it is; undefined if there is no
     * such View or `access` refuses it.
     */
    async activity(id: ViewId, input: { access: ViewAccessPolicy }): Promise<CurrentActivity | null | undefined> {
      const view = await views.findById(id);
      if (!view || !(await input.access.mayOpen(view.id))) return undefined;
      return activity.current();
    },

    /**
     * The View as a calendar feed, or null if there is no such View or `access` refuses it: the
     * Events of the last 30 days and all of the future, cancelled ones included, whatever the
     * View's horizon, that concern someone the View preselects, or all if it preselects no one.
     */
    async feed(id: ViewId, input: { access: ViewAccessPolicy }): Promise<ViewFeed | null> {
      const view = await views.findById(id);
      if (!view || !(await input.access.mayOpen(view.id))) return null;
      const generatedAt = clock.now();
      const firstDay = addDays(localDateTime(generatedAt, timeZone).date, -feedDaysBack);
      const showing: Showing = view.preselected.length > 0 ? view.preselected : "all";
      const around = await itemsAround(firstDay, null, showing);
      const events = around.events.flatMap(({ id: itemId, event }) => {
        if (lastDayOf(event.span, timeZone) < firstDay) return [];
        const { title, span, place, cancelled } = event;
        return [{ itemId, title, span, when: onClocks(span), place, cancelled }];
      });
      const family = await members.list();
      const named = (concerns: Attribution) =>
        concerns === "whole-family" || view.preselected.length === 1 ? [] : family.filter((member) => concerns.includes(member.id));
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
      const { language } = await families.languages();
      return { id: view.id, language, generatedAt, events: events.sort(byStart), schoolDays };
    },
  };
}

export type ViewAccess = ReturnType<typeof createViewAccess>;

/** The Items around some days, by kind, each with whom it concerns. */
type Around = {
  events: { id: ItemId; event: Event; links: TimelineEvent["links"]; messages: TimelineEvent["messages"]; concerns: Attribution }[];
  lessons: { id: ItemId; lesson: Lesson; concerns: Attribution }[];
  /** Those the school withdrew are left out. */
  changes: { id: ItemId; change: TimetableChange; concerns: Attribution }[];
};

/** The same for the same Family Members, whatever their order. */
function concernsKey(concerns: Attribution): string {
  return concerns === "whole-family" ? concerns : [...concerns].sort().join(",");
}

/** Where the first Family Member concerned stands in the Family's order; the whole Family comes first. */
function firstIn(family: { id: FamilyMemberId }[], concerns: Attribution): number {
  return concerns === "whole-family" ? -1 : family.findIndex((member) => concerns.includes(member.id));
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
