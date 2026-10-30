import { isShownTo, taskOf, tickFields, type ItemId, type ViewId } from "@family-agenda/domain";
import { concernsOf } from "./assignment";
import type { AuthoredRevision, Clock, ItemRepository, ProjectedItem, SourceRepository, ViewAccessPolicy, ViewRepository } from "./ports";
import { project } from "./revisions";

export type TasksDeps = {
  clock: Clock;
  items: ItemRepository;
  sources: SourceRepository;
  views: ViewRepository;
};

/** One tick of a Task, or a tick taken back, with when and by whom. */
export type Tick = { done: boolean; at: Date; by: AuthoredRevision["author"] };

export type TickProblem = "unknown-view" | "unknown-task";

/**
 * Ticking Tasks done, the one write a View can make (decisions in #13): anyone with a View, Admins
 * too, ticks a Task done there or takes the tick back. Each is a Revision of its own (ADR-0009), so
 * that a later update from a Source leaves the tick as it is.
 */
export function createTaskAccess(deps: TasksDeps) {
  const { clock, items, sources, views } = deps;

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

    /** The ticks of a Task and those taken back, oldest first. */
    ticks: ticksOf,

  };
}

export type TaskAccess = ReturnType<typeof createTaskAccess>;
