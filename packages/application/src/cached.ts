import type { Clock } from "./ports";

/** Whether an answer tells of a failure: one that throws, or says `ok: false` like a plugin's answer. */
function failed(answer: unknown): boolean {
  return typeof answer === "object" && answer !== null && "ok" in answer && answer.ok === false;
}

/**
 * Keeps slow answers, such as a plugin's or an LLM endpoint's, for `ttlMs` by key, and a failed one
 * only for the shorter `failTtlMs`, so that a broken plugin is not asked on every page but soon
 * again. Callers asking while an answer is on its way share it.
 */
export type Cached = <T>(key: string, ttlMs: number, failTtlMs: number, ask: () => Promise<T>) => Promise<T>;

export function createCache(clock: Clock): Cached {
  const entries = new Map<string, { answer: Promise<unknown>; until: number }>();
  const now = () => clock.now().getTime();
  return <T>(key: string, ttlMs: number, failTtlMs: number, ask: () => Promise<T>): Promise<T> => {
    const known = entries.get(key);
    if (known && now() < known.until) return known.answer as Promise<T>;
    const entry = { answer: ask() as Promise<unknown>, until: Number.POSITIVE_INFINITY };
    entries.set(key, entry);
    entry.answer.then(
      (answer) => (entry.until = now() + (failed(answer) ? failTtlMs : ttlMs)),
      () => (entry.until = now() + failTtlMs),
    );
    return entry.answer as Promise<T>;
  };
}
