import type { SourceTypeRegistry } from "./ports";

/** How long a plugin may take to run a Source, unless the Instance says otherwise: as long as the Plugin Host lets a call run. */
export const defaultPluginTimeoutMs = 2 * 60 * 1000;

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

/** The registry, but migrating a Source's configuration takes at most `ms`, so that no caller waits for a hanging plugin. */
export function timeBoundRegistry(registry: SourceTypeRegistry, ms: number): SourceTypeRegistry {
  return {
    installed: () => registry.installed(),
    load: (id) => registry.load(id),
    migrateConfig(id, plain, fromVersion) {
      return withinTime(registry.migrateConfig(id, plain, fromVersion), ms, () => ({ ok: false }) as const);
    },
  };
}
