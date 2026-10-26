import { randomUUID } from "node:crypto";
import {
  addDays,
  isAcceptableHorizon,
  localDateTime,
  type FamilyMemberId,
  type LocalDate,
  type LocalTime,
  type ViewId,
} from "@family-butler/domain";
import { summariseFamilyMember, type FamilyMemberSummary } from "./family-members";
import type {
  Clock,
  FamilyMemberRepository,
  FamilyRepository,
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
};

export type ViewSettings = { preselected: FamilyMemberId[]; horizonDays: number };

export type ViewSummary = ViewSettings & { id: ViewId };

export type ViewProblem = "invalid-horizon" | "unknown-member";

/** Whom the quick filter shows: some Family Members, or everyone. */
export type Showing = FamilyMemberId[] | "all";

export type ViewPage = {
  id: ViewId;
  now: { date: LocalDate; time: LocalTime };
  /** Everyone in the Family, for the quick filter. */
  members: FamilyMemberSummary[];
  showing: Showing;
  /** One per day of the horizon, today first. There are no Items yet. */
  days: { date: LocalDate; items: never[] }[];
};

/** Lets every View open, as on the local listener (ADR-0003). */
export const openViewAccess: ViewAccessPolicy = { mayOpen: () => Promise.resolve(true) };

export function createViewAccess(deps: ViewsDeps) {
  const { clock, timeZone, families, members, views } = deps;

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
      const now = localDateTime(clock.now(), timeZone);
      return {
        id: view.id,
        now,
        members: family.map(summariseFamilyMember),
        showing: showing.length > 0 ? showing : "all",
        days: Array.from({ length: view.horizonDays }, (_, day) => ({
          date: addDays(now.date, day),
          items: [],
        })),
      };
    },
  };
}

export type ViewAccess = ReturnType<typeof createViewAccess>;
