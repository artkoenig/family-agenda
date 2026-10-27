import type { ActivityKind, ActivityRepository, BackgroundActivity, Clock, FamilyRepository } from "./ports";

export type ActivityDeps = {
  clock: Clock;
  families: FamilyRepository;
  activities: ActivityRepository;
};

/** One activity under way, which counts its steps until it ends. */
export type ActivityProgress = {
  /** One more Source or message is done. */
  advance(): Promise<void>;
  end(): Promise<void>;
};

/** What a View shows of the worker's activity. */
export type CurrentActivity = Pick<BackgroundActivity, "kind" | "done" | "total">;

/**
 * An activity not updated for this long is taken for one whose worker stopped, as a crash
 * leaves it behind. One step may read a long PDF through the LLM endpoint.
 */
const staleAfterMs = 15 * 60 * 1000;

/** What the worker is busy with, recorded by the worker and shown on the Views. */
export function createActivityLog(deps: ActivityDeps) {
  const { clock, families, activities } = deps;
  return {
    async begin(kind: ActivityKind, total: number): Promise<ActivityProgress> {
      const familyId = await families.theFamily();
      let done = 0;
      const save = () => activities.save(familyId, { kind, done, total, updatedAt: clock.now() });
      await save();
      return {
        async advance() {
          done += 1;
          await save();
        },
        end: () => activities.clear(familyId),
      };
    },

    /** The worker's current activity; null when it is idle, or stopped in the middle. */
    async current(): Promise<CurrentActivity | null> {
      const activity = await activities.find(await families.theFamily());
      if (!activity || clock.now().getTime() - activity.updatedAt.getTime() > staleAfterMs) return null;
      return { kind: activity.kind, done: activity.done, total: activity.total };
    },
  };
}

export type ActivityLog = ReturnType<typeof createActivityLog>;
