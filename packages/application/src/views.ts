import { randomUUID } from "node:crypto";
import {
  addDays,
  eventOf,
  isAcceptableHorizon,
  localDateTime,
  spanOnDay,
  type Event,
  type FamilyId,
  type FamilyMemberId,
  type ItemId,
  type LocalDate,
  type LocalTime,
  type ViewId,
} from "@family-butler/domain";
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
};

export type ViewPage = {
  id: ViewId;
  now: LocalDateTime;
  /** Everyone in the Family, for the quick filter. */
  members: FamilyMemberSummary[];
  showing: Showing;
  /** One per day of the horizon, today first, each with its Events in order of time. */
  days: { date: LocalDate; items: TimelineEvent[] }[];
};

/** Lets every View open, as on the local listener (ADR-0003). */
export const openViewAccess: ViewAccessPolicy = { mayOpen: () => Promise.resolve(true) };

export function createViewAccess(deps: ViewsDeps) {
  const { clock, timeZone, families, members, views, items } = deps;

  /** The Family's Events on each of the days, in order of time. */
  async function timelineOf(familyId: FamilyId, dates: LocalDate[], now: Date): Promise<ViewPage["days"]> {
    const first = dates[0];
    const last = dates.at(-1);
    if (!first || !last) return [];
    // A day lasts at most 26 hours, and no time zone is more than 14 hours from UTC.
    const day = 24 * 60 * 60 * 1000;
    const from = new Date(new Date(`${first}T00:00:00Z`).getTime() - day);
    const to = new Date(new Date(`${addDays(last, 1)}T00:00:00Z`).getTime() + day);
    const events = (await items.overlapping(familyId, from, to)).flatMap((item) => {
      const event = item.kind === "event" ? eventOf(item.folded) : null;
      return event ? [{ id: item.id, event, links: item.links }] : [];
    });
    return dates.map((date) => ({
      date,
      items: events
        .flatMap(({ id, event, links }) => {
          const on = spanOnDay(event.span, date, timeZone);
          return on ? [row(id, event, links, on, now)] : [];
        })
        .sort(byTime),
    }));
  }

  function row(
    itemId: ItemId,
    event: Event,
    links: string[],
    on: { from: LocalTime | null; until: LocalTime | null },
    now: Date,
  ): TimelineEvent {
    const { span } = event;
    return {
      itemId,
      title: event.title,
      ...on,
      span: span.allDay
        ? span
        : { allDay: false, start: localDateTime(span.start, timeZone), end: localDateTime(span.end, timeZone) },
      place: event.place,
      cancelled: event.cancelled,
      earlier: !span.allDay && span.end <= now,
      links,
    };
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
     */
    async open(id: ViewId, input: { access: ViewAccessPolicy; show?: Showing }): Promise<ViewPage | null> {
      const view = await views.findById(id);
      if (!view || !(await input.access.mayOpen(view.id))) return null;
      const family = await members.list(view.familyId);
      const show = input.show ?? view.preselected;
      const showing = show === "all" ? [] : family.map((member) => member.id).filter((memberId) => show.includes(memberId));
      const instant = clock.now();
      const now = localDateTime(instant, timeZone);
      const dates = Array.from({ length: view.horizonDays }, (_, day) => addDays(now.date, day));
      return {
        id: view.id,
        now,
        members: family.map(summariseFamilyMember),
        showing: showing.length > 0 ? showing : "all",
        days: await timelineOf(view.familyId, dates, instant),
      };
    },
  };
}

export type ViewAccess = ReturnType<typeof createViewAccess>;

/** All-day rows first, then by the time they start on the day, earliest first. */
function byTime(a: TimelineEvent, b: TimelineEvent): number {
  const key = (row: TimelineEvent) => (row.span.allDay ? "" : (row.from ?? "00:00"));
  return key(a).localeCompare(key(b)) || a.title.localeCompare(b.title);
}
