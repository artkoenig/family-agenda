import type { Clock } from "./ports";

/** Whether an answer tells of a failure, as a plugin's answer says `ok: false`. */
function failed(answer: unknown): boolean {
  return typeof answer === "object" && answer !== null && "ok" in answer && answer.ok === false;
}

/** An answer that did not come within the cache's time limit. */
export class CachedTimeout extends Error {
  constructor(key: string, ms: number) {
    super(`No answer for ${key} within ${ms} ms.`);
  }
}

export type CachedOptions = {
  /** Once the answer is old, it is still given while a new one is asked for in the background. */
  stale?: boolean;
};

/**
 * Keeps slow answers, such as a plugin's or an LLM endpoint's, for `ttlMs` by key, and one saying
 * `ok: false` only for the shorter `failTtlMs`, so that a broken plugin is not asked on every page
 * but soon again. An answer that throws is not kept; one that takes longer than the cache's time
 * limit fails with `CachedTimeout`, kept like a failure. Callers asking while an answer is on its
 * way share it.
 */
export type Cached = <T>(key: string, ttlMs: number, failTtlMs: number, ask: () => Promise<T>, options?: CachedOptions) => Promise<T>;

/** `previous` is the answer given meanwhile to callers that take a stale one. */
type Entry = { answer: Promise<unknown>; until: number; settled: boolean; previous?: Promise<unknown> };

/** How long an answer may take by default before it counts as failed. */
const defaultTimeoutMs = 30_000;

export function createCache(clock: Clock, options: { timeoutMs?: number } = {}): Cached {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const entries = new Map<string, Entry>();
  const now = () => clock.now().getTime();

  /** Forgets answers that are old, so that the cache does not grow with keys no longer asked for. */
  function prune() {
    for (const [key, entry] of entries) if (entry.settled && now() >= entry.until) entries.delete(key);
  }

  function ask(key: string, ttlMs: number, failTtlMs: number, asking: () => Promise<unknown>, previous?: Promise<unknown>): Entry {
    prune();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new CachedTimeout(key, timeoutMs)); }, timeoutMs);
      timer.unref();
    });
    const entry: Entry = { answer: Promise.race([asking(), timeout]), until: Number.POSITIVE_INFINITY, settled: false, ...(previous ? { previous } : {}) };
    entries.set(key, entry);
    const settle = (lifetimeMs: number) => {
      clearTimeout(timer);
      entry.settled = true;
      entry.until = now() + lifetimeMs;
    };
    entry.answer.then(
      (answer) => { settle(failed(answer) ? failTtlMs : ttlMs); },
      (error: unknown) => {
        settle(failTtlMs);
        if (!(error instanceof CachedTimeout) && entries.get(key) === entry) entries.delete(key);
      },
    );
    return entry;
  }

  return <T>(key: string, ttlMs: number, failTtlMs: number, asking: () => Promise<T>, given: CachedOptions = {}): Promise<T> => {
    const known = entries.get(key);
    if (known && given.stale && known.previous && !known.settled) return known.previous as Promise<T>;
    if (known && now() < known.until) return known.answer as Promise<T>;
    if (known && given.stale) {
      // Asked again in the background; until then, the old answer.
      ask(key, ttlMs, failTtlMs, asking, known.answer).answer.catch(() => undefined);
      return known.answer as Promise<T>;
    }
    return ask(key, ttlMs, failTtlMs, asking).answer as Promise<T>;
  };
}
