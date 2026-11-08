import type { SourceTypeId } from "@family-agenda/domain";
import type { InstalledSourceType, SourceTypeRegistry } from "./ports";

/** How long a plugin may take to load or to run a Source, unless the Instance says otherwise. */
export const defaultPluginTimeoutMs = 5 * 60 * 1000;

/** A time as the Admin area words it, such as "0.5 seconds". */
function seconds(ms: number): string {
  return `${ms / 1000} seconds`;
}

/** What a promise settles with, or `late()` if it takes longer than `ms`; the promise itself goes on. */
export async function withinTime<T>(promise: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(late());
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Why a run that took too long failed. */
export function noAnswerWithin(ms: number): string {
  return `The plugin did not answer within ${seconds(ms)}.`;
}

/**
 * The registry, but a plugin whose code does not load within `ms` counts as not loadable until it
 * does, so that neither polling nor the Admin area waits for it. Its loading goes on meanwhile.
 */
export function timeBoundRegistry(registry: SourceTypeRegistry, ms: number): SourceTypeRegistry {
  const late = new Set<string>();
  const reason = `The plugin did not load within ${seconds(ms)}.`;
  return {
    installed(): InstalledSourceType[] {
      return registry.installed().map((type) => (late.has(type.id) && type.notLoadable === null ? { ...type, notLoadable: reason } : type));
    },
    async load(id: SourceTypeId) {
      const loading = registry.load(id).finally(() => late.delete(id));
      return withinTime(loading, ms, () => {
        late.add(id);
        return { ok: false } as const;
      });
    },
    migrateConfig(id, plain, fromVersion) {
      return withinTime(registry.migrateConfig(id, plain, fromVersion), ms, () => ({ ok: false }) as const);
    },
  };
}
