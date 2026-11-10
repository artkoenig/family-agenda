import { describe, expect, it } from "vitest";
import { createCache } from "../src/cached";

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

    const throwing = () => Promise.reject(new Error(`thrown ${++asked}`));
    await expect(cached("t", 1000, 100, throwing)).rejects.toThrow("thrown 3");
    clock.advance(99);
    await expect(cached("t", 1000, 100, throwing)).rejects.toThrow("thrown 3");
    clock.advance(1);
    await expect(cached("t", 1000, 100, throwing)).rejects.toThrow("thrown 4");
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
