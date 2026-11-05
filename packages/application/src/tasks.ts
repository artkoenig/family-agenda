import { isShownTo, type ItemId, type AgendaId } from "@family-agenda/domain";
import { concernsOf } from "./assignment";
import type { Clock, ItemRepository, ProjectedItem, AgendaAccessPolicy, AgendaRepository } from "./ports";

export type TasksDeps = {
  clock: Clock;
  items: ItemRepository;
  agendas: AgendaRepository;
};

export type TickProblem = "unknown-agenda" | "unknown-task";

/**
 * Ticking Tasks done, the one write an Agenda can make (decisions in #13): anyone with an Agenda,
 * Admins too, ticks a Task done there or takes the tick back. The tick is kept when a Source
 * states the Task again.
 */
export function createTaskAccess(deps: TasksDeps) {
  const { clock, items, agendas } = deps;

  /** Ticks the Task, unless it already is as ticked. */
  async function tick(id: ItemId, done: boolean, mayTick: (item: Pick<ProjectedItem, "assignments">) => boolean) {
    const item = await items.find(id);
    if (!item || item.kind !== "task" || !mayTick(item)) return { ok: false as const, problem: "unknown-task" as const };
    if ((item.task.doneAt !== null) === done) return { ok: true as const };
    await items.setTaskDone(id, done ? clock.now() : null);
    return { ok: true as const };
  }

  return {
    /**
     * Ticks a Task done in an Agenda, or takes the tick back. Only a Task the Agenda shows can be:
     * one that concerns someone it is for; an Agenda for the whole Family shows every Task.
     */
    async tickFromAgenda(
      agendaId: AgendaId,
      id: ItemId,
      input: { done: boolean; access: AgendaAccessPolicy },
    ): Promise<{ ok: true } | { ok: false; problem: TickProblem }> {
      const agenda = await agendas.findById(agendaId);
      if (!agenda || !(await input.access.mayOpen(agenda.id))) return { ok: false, problem: "unknown-agenda" };
      return tick(id, input.done, (item) => agenda.memberIds.length === 0 || isShownTo(concernsOf(item), agenda.memberIds));
    },
  };
}

export type TaskAccess = ReturnType<typeof createTaskAccess>;
