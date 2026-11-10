import { describe, expect, it } from "vitest";
import { CachedTimeout, createCache } from "../src/cached";

function clockAt(start: number) {
  let now = start;
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

describe("A cache of slow answers, such as a plugin's", () => {
  it("answers from the cache until the answer is older than its lifetime", async () => {
    const clock = clockAt(0);
    const cached = createCache(clock);
    let asked = 0;
    const ask = () => Promise.resolve({ ok: true as const, value: ++asked });

    expect(await cached("k", 1000, 100, ask)).toEqual({ ok: true, value: 1 });
    clock.advance(999);
    expect(await cached("k", 1000, 100, ask)).toEqual({ ok: true, value: 1 });
    clock.advance(1);
    expect(await cached("k", 1000, 100, ask)).toEqual({ ok: true, value: 2 });
  });

  it("keeps an answer apart for each key", async () => {
    const cached = createCache(clockAt(0));
    expect(await cached("a", 1000, 100, () => Promise.resolve("A"))).toBe("A");
    expect(await cached("b", 1000, 100, () => Promise.resolve("B"))).toBe("B");
  });

  it("keeps a failed answer only for the shorter time, whether it says it failed or throws", async () => {
    const clock = clockAt(0);
    const cached = createCache(clock);
    let asked = 0;
    const failing = () => Promise.resolve({ ok: false as const, message: `failed ${++asked}` });

    expect(await cached("k", 1000, 100, failing)).toEqual({ ok: false, message: "failed 1" });
    clock.advance(99);
    expect(await cached("k", 1000, 100, failing)).toEqual({ ok: false, message: "failed 1" });
    clock.advance(1);
    expect(await cached("k", 1000, 100, failing)).toEqual({ ok: false, message: "failed 2" });

  });

  it("does not keep an answer that throws", async () => {
    const cached = createCache(clockAt(0));
    let asked = 0;
    const throwing = () => Promise.reject(new Error(`thrown ${++asked}`));
    await expect(cached("t", 1000, 100, throwing)).rejects.toThrow("thrown 1");
    await expect(cached("t", 1000, 100, throwing)).rejects.toThrow("thrown 2");
  });

  it("fails an answer that takes too long, and keeps that failure for the shorter time", async () => {
    const clock = clockAt(0);
    const cached = createCache(clock, { timeoutMs: 10 });
    let asked = 0;
    const hanging = () => {
      asked++;
      return new Promise<string>(() => undefined);
    };
    await expect(cached("k", 1000, 100, hanging)).rejects.toBeInstanceOf(CachedTimeout);
    await expect(cached("k", 1000, 100, hanging)).rejects.toBeInstanceOf(CachedTimeout);
    expect(asked).toBe(1);
    clock.advance(100);
    await expect(cached("k", 1000, 100, hanging)).rejects.toBeInstanceOf(CachedTimeout);
    expect(asked).toBe(2);
  });

  it("gives a stale answer while it asks again in the background, then the new one", async () => {
    const clock = clockAt(0);
    const cached = createCache(clock);
    let answer: (value: string) => void = () => undefined;
    let asked = 0;
    const ask = () => {
      asked++;
      return asked === 1 ? Promise.resolve("old") : new Promise<string>((resolve) => (answer = resolve));
    };
    expect(await cached("k", 1000, 100, ask, { stale: true })).toBe("old");
    clock.advance(1000);
    expect(await cached("k", 1000, 100, ask, { stale: true })).toBe("old");
    expect(await cached("k", 1000, 100, ask, { stale: true }), "while the new answer is on its way").toBe("old");
    expect(asked).toBe(2);
    answer("new");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cached("k", 1000, 100, ask, { stale: true })).toBe("new");
  });

  it("forgets old answers of other keys once it asks anew", async () => {
    const clock = clockAt(0);
    const cached = createCache(clock);
    let asked = 0;
    const ask = () => Promise.resolve(++asked);
    await cached("a", 1000, 100, ask);
    clock.advance(1000);
    await cached("b", 1000, 100, ask);
    expect(await cached("a", 1000, 100, ask)).toBe(3);
  });

  it("lets callers asking at the same time share one answer", async () => {
    const cached = createCache(clockAt(0));
    let asked = 0;
    let answer: (value: string) => void = () => undefined;
    const ask = () => {
      asked++;
      return new Promise<string>((resolve) => (answer = resolve));
    };
    const first = cached("k", 0, 0, ask);
    const second = cached("k", 0, 0, ask);
    answer("shared");
    expect(await Promise.all([first, second])).toEqual(["shared", "shared"]);
    expect(asked).toBe(1);
  });
});
