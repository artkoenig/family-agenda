import type { Application } from "../../../src/composition-root";

/** What a test fakes: per access, only the methods it expects the pages to call. */
export type Fakes = {
  [K in keyof Application]?: Application[K] extends (...args: never[]) => unknown
    ? Application[K]
    : Application[K] extends object
      ? Partial<Application[K]>
      : Application[K];
};

/** A call a page made that its test did not fake, such as `sources.edit`. */
export type Unfaked = string;

/**
 * An `Application` without a database: every access answers only what `fakes` gives it. A call
 * of anything else is recorded in `unfaked` and rejected, so that the test fails naming it rather
 * than the page silently rendering an error.
 */
export function fakeApplication(fakes: Fakes): { application: Application; unfaked: Unfaked[] } {
  const unfaked: Unfaked[] = [];
  const defaults: Fakes = {
    timeZone: "Europe/Berlin",
    // Asks every time: a test controls timing through its fakes and routes, not a cache.
    cached: (_key, _ttlMs, _failTtlMs, ask) => ask(),
  };
  const given: Record<string, unknown> = { ...defaults, ...fakes };
  const accessOf = (name: string) => {
    const methods = (given[name] ?? {}) as Record<string, unknown>;
    return new Proxy(methods, {
      get: (target, method) => {
        if (typeof method !== "string") return undefined;
        if (method in target) return target[method];
        return () => {
          unfaked.push(`${name}.${method}`);
          return Promise.reject(new Error(`not faked: ${name}.${method}`));
        };
      },
    });
  };
  const application = new Proxy({} as Application, {
    get: (_target, name) => {
      if (typeof name !== "string") return undefined;
      const value = given[name];
      if (value !== undefined && (typeof value !== "object" || value === null)) return value;
      return accessOf(name);
    },
  });
  return { application, unfaked };
}
