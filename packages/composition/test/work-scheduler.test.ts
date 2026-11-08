import { maximumSleepMs } from "@family-agenda/application";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkScheduler, logDueWorkReport, type WorkSchedulerDeps } from "../src/work-scheduler";

const family = { databaseUrl: "postgres://db/family", masterKey: Buffer.alloc(32), blobDirectory: "/blobs", timeZone: "UTC" };
const now = Date.parse("2026-11-08T10:00:00Z");

const recorder = () => {
  const lines: string[] = [];
  return { lines, log: { warn: (m: string) => lines.push(`warn ${m}`), error: (m: string) => lines.push(`error ${m}`) } };
};

const emptyPoll = { polled: [], failed: [], invalid: [], refused: [] };
const emptyExtraction = { extracted: [], dropped: [], failed: [] };

function workerWith(parts: Partial<WorkSchedulerDeps["worker"]> = {}): WorkSchedulerDeps["worker"] {
  return {
    poll: () => Promise.resolve({ report: emptyPoll, nextDueAt: null }),
    extract: () => Promise.resolve({ report: emptyExtraction, nextDueAt: new Date(now + 3_000) }),
    cleanup: () => Promise.resolve({ purged: 0, deleted: 0, swept: 0 }),
    ...parts,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("logging a round of due work", () => {
  it("reports what polling and extraction found, and what made them fail", () => {
    const { lines, log } = recorder();
    logDueWorkReport(
      {
        polling: { polled: [], failed: [{ sourceId: "s1", kind: "network", message: "down" }], refused: [{ sourceId: "s2", attributes: ["a"] }], invalid: [{ sourceId: "s3", externalId: "e", problems: ["p"] }] },
        extraction: { extracted: [], failed: [{ messageId: "m1", problem: "llm", message: "bad" }], dropped: [{ messageId: "m2", title: null, problem: "check" }] },
        errors: [],
      } as never,
      log,
    );

    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("warn Source s1 failed (network): down");
  });
});

describe("the schedule api keeps for the worker", () => {
  it("polls, then extracts, and waits until the worker says work is next due, at most a while", async () => {
    const calls: string[] = [];
    const { log } = recorder();
    const scheduler = createWorkScheduler({
      worker: workerWith({
        poll: () => {
          calls.push("poll");
          return Promise.resolve({ report: emptyPoll, nextDueAt: null });
        },
        extract: () => {
          calls.push("extract");
          return Promise.resolve({ report: emptyExtraction, nextDueAt: new Date(now + 3_000) });
        },
      }),
      family,
      log,
      now: () => now,
    });

    expect(await scheduler.round()).toBe(3_000);
    expect(calls).toEqual(["poll", "extract"]);

    const idle = createWorkScheduler({ worker: workerWith({ extract: () => Promise.resolve({ report: emptyExtraction, nextDueAt: null }) }), family, log, now: () => now });
    expect(await idle.round()).toBe(maximumSleepMs);
    const overdue = createWorkScheduler({ worker: workerWith({ extract: () => Promise.resolve({ report: emptyExtraction, nextDueAt: new Date(now - 1) }) }), family, log, now: () => now });
    expect(await overdue.round()).toBe(0);
  });

  it("logs a worker that fails and asks it again after a while", async () => {
    const { lines, log } = recorder();
    const down = () => Promise.reject(new Error("unreachable"));
    const scheduler = createWorkScheduler({ worker: workerWith({ poll: down, extract: down }), family, log });

    expect(await scheduler.round()).toBe(maximumSleepMs);
    expect(lines).toEqual(["error Polling Sources failed:", "error Extracting messages failed:"]);
  });

  it("reports a cleanup that throws", async () => {
    const { lines, log } = recorder();
    const scheduler = createWorkScheduler({ worker: workerWith({ cleanup: () => Promise.reject(new Error("boom")) }), family, log });

    await scheduler.cleanup();

    expect(lines).toEqual(["error Cleaning up (retention, secrets nothing refers to) failed:"]);
  });

  it("runs rounds and cleans up once started, until stopped", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const count = (name: string, answer: unknown) => () => {
      calls.push(name);
      return Promise.resolve(answer as never);
    };
    const scheduler = createWorkScheduler({
      worker: {
        poll: count("poll", { report: emptyPoll, nextDueAt: null }),
        extract: count("extract", { report: emptyExtraction, nextDueAt: null }),
        cleanup: count("cleanup", { purged: 0, deleted: 0, swept: 0 }),
      },
      family,
      log: recorder().log,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(maximumSleepMs);
    await scheduler.stop();
    const rounds = calls.filter((call) => call === "poll").length;
    await vi.advanceTimersByTimeAsync(maximumSleepMs * 2);

    expect(rounds).toBe(2);
    expect(calls.filter((call) => call === "poll")).toHaveLength(rounds);
    expect(calls.filter((call) => call === "cleanup")).toHaveLength(1);
  });
});
