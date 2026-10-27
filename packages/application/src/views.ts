import { randomUUID } from "node:crypto";
import {
  addDays,
  daysBetween,
  eventOf,
  isAcceptableHorizon,
  isAcceptableTimelineRange,
  lastDayOf,
  localDateTime,
  spanOnDay,
  type Event,
  type FamilyId,
  type FamilyMemberId,
  type ItemId,
  type LocalDate,
  type LocalTime,
  type RawMessageId,
  type TimeSpan,
  type ViewId,
} from "@family-agenda/domain";
import type { ActivityLog, CurrentActivity } from "./activity";
import { summariseFamilyMember, type FamilyMemberSummary } from "./family-members";
import type {
  Clock,
  FamilyMemberRepository,
  FamilyRepository,
  ItemRepository,
  ViewAccessPolicy,
  ViewRepository,
} from "./ports";

export type ViewsDeps = {
  clock: Clock;
  /** The IANA time zone the Family lives in, which decides where a day starts. */
  timeZone: string;
  families: FamilyRepository;
  members: FamilyMemberRepository;
  views: ViewRepository;
  items: ItemRepository;
  activity: ActivityLog;
};

export type ViewSettings = { preselected: FamilyMemberId[]; horizonDays: number };

export type ViewSummary = ViewSettings & { id: ViewId };

export type ViewProblem = "invalid-horizon" | "unknown-member";

/** Whom the quick filter shows: some Family Members, or everyone. */
export type Showing = FamilyMemberId[] | "all";

/** A date and time on the Family's clocks. */
export type LocalDateTime = { date: LocalDate; time: LocalTime };

/**
 * An Event as one row of a day. Until there are Attribution Rules, every Event concerns the
 * whole Family, so the quick filter never hides it.
 */
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
  /** Where the original can be looked at. */
  links: string[];
  /** The raw messages it was extracted from, which Admins can open. */
  messages: RawMessageId[];
};

export type ViewPage = {
  id: ViewId;
  now: LocalDateTime;
  /** Everyone in the Family, for the quick filter. */
  members: FamilyMemberSummary[];
  showing: Showing;
  /** How many days one step of scrolling loads: the View's horizon. */
  horizonDays: number;
  /**
   * One per day shown, each with its Events in order of time: the horizon from today, or the
   * days scrolled to.
   */
  days: { date: LocalDate; items: TimelineEvent[] }[];
  /** What the worker is busy with, such as reading messages; null when it is idle. */
  activity: CurrentActivity | null;
};

/** Days of a timeline, from `first` to `last`, both included. */
export type TimelineDays = { first: LocalDate; last: LocalDate };

/**
 * An Event in a View's feed. Until there are Attribution Rules, every Event concerns the whole
 * Family, so every feed carries it, whomever its View preselects, and without names in its title.
 */
export type FeedEvent = {
  itemId: ItemId;
  title: string;
  span: TimeSpan;
  /** The span on the Family's clocks, for the details. */
  when: TimelineEvent["span"];
  place: string | null;
  cancelled: boolean;
};

export type ViewFeed = {
  id: ViewId;
  generatedAt: Date;
  /** Those of the last 30 days and all of the future, in order of time. */
  events: FeedEvent[];
};

/** How many days back a feed reaches, today not counted. */
const feedDaysBack = 30;

/** Lets every View open, as on the local listener (ADR-0003). */
export const openViewAccess: ViewAccessPolicy = { mayOpen: () => Promise.resolve(true) };

export function createViewAccess(deps: ViewsDeps) {
  const { clock, timeZone, families, members, views, items, activity } = deps;

  /**
   * The Family's Events that may touch the days from `first` to `last`, or all later days if
   * `last` is null; the caller decides by the Family's time zone.
   */
  async function eventsAround(familyId: FamilyId, first: LocalDate, last: LocalDate | null) {
    // A day lasts at most 26 hours, and no time zone is more than 14 hours from UTC.
    const day = 24 * 60 * 60 * 1000;
    const from = new Date(new Date(`${first}T00:00:00Z`).getTime() - day);
    const to = last ? new Date(new Date(`${addDays(last, 1)}T00:00:00Z`).getTime() + day) : null;
    return (await items.overlapping(familyId, from, to)).flatMap((item) => {
      const event = item.kind === "event" ? eventOf(item.folded) : null;
      return event ? [{ id: item.id, event, links: item.links, messages: item.messages }] : [];
    });
  }

  /** The Family's Events on each of the days, in order of time. */
  async function timelineOf(familyId: FamilyId, dates: LocalDate[], now: Date): Promise<ViewPage["days"]> {
    const first = dates[0];
    const last = dates.at(-1);
    if (!first || !last) return [];
    const events = await eventsAround(familyId, first, last);
    return dates.map((date) => ({
      date,
      items: events
        .flatMap(({ id, event, links, messages }) => {
          const on = spanOnDay(event.span, date, timeZone);
          return on ? [row(id, event, { links, messages }, on, now)] : [];
        })
        .sort(byTime),
    }));
  }

  function row(
    itemId: ItemId,
    event: Event,
    originals: Pick<TimelineEvent, "links" | "messages">,
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
    const known = (await members.list(await families.theFamily())).map((member) => member.id);
    if (!settings.preselected.every((id) => known.includes(id))) {
      return { ok: false, problem: "unknown-member" };
    }
    const preselected = known.filter((id) => settings.preselected.includes(id));
    return { ok: true, settings: { preselected, horizonDays: settings.horizonDays } };
  }

  return {
    async list(): Promise<ViewSummary[]> {
      const all = await views.list(await families.theFamily());
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
        familyId: await families.theFamily(),
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
     * `show` is what the quick filter was set to; without it, it starts with the preselection.
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
      const family = await members.list(view.familyId);
      const show = input.show ?? view.preselected;
      const showing = show === "all" ? [] : family.map((member) => member.id).filter((memberId) => show.includes(memberId));
      const instant = clock.now();
      const now = localDateTime(instant, timeZone);
      const { first, last } = input.days ?? { first: now.date, last: addDays(now.date, view.horizonDays - 1) };
      const dates = Array.from({ length: daysBetween(first, last) + 1 }, (_, day) => addDays(first, day));
      return {
        id: view.id,
        now,
        members: family.map(summariseFamilyMember),
        showing: showing.length > 0 ? showing : "all",
        horizonDays: view.horizonDays,
        days: await timelineOf(view.familyId, dates, instant),
        activity: await activity.current(),
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
     * View's horizon.
     */
    async feed(id: ViewId, input: { access: ViewAccessPolicy }): Promise<ViewFeed | null> {
      const view = await views.findById(id);
      if (!view || !(await input.access.mayOpen(view.id))) return null;
      const generatedAt = clock.now();
      const firstDay = addDays(localDateTime(generatedAt, timeZone).date, -feedDaysBack);
      const events = (await eventsAround(view.familyId, firstDay, null)).flatMap(({ id: itemId, event }) => {
        if (lastDayOf(event.span, timeZone) < firstDay) return [];
        const { title, span, place, cancelled } = event;
        return [{ itemId, title, span, when: onClocks(span), place, cancelled }];
      });
      return { id: view.id, generatedAt, events: events.sort(byStart) };
    },
  };
}

export type ViewAccess = ReturnType<typeof createViewAccess>;

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
