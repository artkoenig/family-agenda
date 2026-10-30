import {
  addDays,
  isPinned,
  isShownTo,
  localDateTime,
  taskOf,
  taskStatus,
  tickFields,
  type AdminId,
  type ItemId,
  type LocalDate,
  type TaskStatus,
  type ViewId,
} from "@family-agenda/domain";
import { concernsOf } from "./assignment";
import type { AuthoredRevision, Clock, ItemRepository, ProjectedItem, SourceRepository, ViewAccessPolicy, ViewRepository } from "./ports";
import { project } from "./revisions";

export type TasksDeps = {
  clock: Clock;
  /** The IANA time zone the Family lives in, which decides when a Task is Due. */
  timeZone: string;
  items: ItemRepository;
  sources: SourceRepository;
  views: ViewRepository;
};

/** One tick of a Task, or a tick taken back, with when and by whom. */
export type Tick = { done: boolean; at: Date; by: AuthoredRevision["author"] };

export type TickProblem = "unknown-view" | "unknown-task";

/** A Task as the Admin area lists it, with its ticks. */
export type TaskSummary = {
  itemId: ItemId;
  title: string;
  deadline: LocalDate | null;
  bring: string[];
  status: TaskStatus;
  pinned: boolean;
  cancelled: boolean;
  ticks: Tick[];
};

/** How many days back the Admin area lists Tasks that are done, today not counted. */
const listedDaysBack = 30;

/**
 * Ticking Tasks done, the one write a View can make (decisions in #13): anyone with a View, or an
 * Admin, ticks a Task done or takes the tick back. Each is a Revision of its own (ADR-0009), so
 * that a later update from a Source leaves the tick as it is.
 */
export function createTaskAccess(deps: TasksDeps) {
  const { clock, timeZone, items, sources, views } = deps;

  async function ticksOf(id: ItemId): Promise<Tick[]> {
    return (await items.authoredRevisions(id)).flatMap((revision) =>
      "done" in revision.fields ? [{ done: revision.fields.done !== null, at: revision.sourceTime, by: revision.author }] : [],
    );
  }

  /** Ticks the Task, unless it already is as ticked. */
  async function tick(id: ItemId, done: boolean, author: AuthoredRevision["author"], mayTick: (item: Pick<ProjectedItem, "sources">) => Promise<boolean>) {
    const item = await items.find(id);
    const task = item?.kind === "task" ? taskOf(item.folded) : null;
    if (!item || !task || !(await mayTick(item))) return { ok: false as const, problem: "unknown-task" as const };
    if ((task.doneAt !== null) === done) return { ok: true as const };
    const at = clock.now();
    await items.appendAuthored(id, { act: "change", fields: tickFields(done, at), sourceTime: at, author }, project);
    return { ok: true as const };
  }

  return {
    /**
     * Ticks a Task done in a View, or takes the tick back. Only a Task the View shows can be:
     * one that concerns someone it preselects, or the whole Family.
     */
    async tickFromView(
      viewId: ViewId,
      id: ItemId,
      input: { done: boolean; access: ViewAccessPolicy },
    ): Promise<{ ok: true } | { ok: false; problem: TickProblem }> {
      const view = await views.findById(viewId);
      if (!view || !(await input.access.mayOpen(view.id))) return { ok: false, problem: "unknown-view" };
      return tick(id, input.done, { kind: "view", viewId }, async (item) => {
        if (view.preselected.length === 0) return true;
        return isShownTo(concernsOf(item, await sources.list()), view.preselected);
      });
    },

    /** Ticks a Task done in the Admin area, or takes the tick back. */
    async tickAsAdmin(adminId: AdminId, id: ItemId, input: { done: boolean }): Promise<{ ok: true } | { ok: false; problem: TickProblem }> {
      return tick(id, input.done, { kind: "admin", adminId }, () => Promise.resolve(true));
    },

    /** The ticks of a Task and those taken back, oldest first. */
    ticks: ticksOf,

    /**
     * The Family's Tasks for the Admin area: those pinned, by Deadline, then those not Due yet,
     * then those done in the last 30 days or later.
     */
    async list(): Promise<TaskSummary[]> {
      const now = clock.now();
      const today = localDateTime(now, timeZone).date;
      // A day lasts at most 26 hours, and no time zone is more than 14 hours from UTC.
      const from = new Date(new Date(`${addDays(today, -listedDaysBack)}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000);
      const found = [...(await items.outstanding()), ...(await items.overlapping(from, null))];
      const unique = [...new Map(found.map((item) => [item.id, item])).values()];
      const summaries: TaskSummary[] = [];
      for (const item of unique) {
        const task = item.kind === "task" ? taskOf(item.folded) : null;
        if (!task) continue;
        const { title, deadline, bring, cancelled } = task;
        const status = taskStatus(task, today);
        summaries.push({ itemId: item.id, title, deadline, bring, status, pinned: isPinned(task, today), cancelled, ticks: await ticksOf(item.id) });
      }
      const rank = (task: TaskSummary) => (task.pinned ? 0 : task.status === "upcoming" ? 1 : 2);
      return summaries.sort(
        (a, b) => rank(a) - rank(b) || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || a.title.localeCompare(b.title),
      );
    },
  };
}

export type TaskAccess = ReturnType<typeof createTaskAccess>;
