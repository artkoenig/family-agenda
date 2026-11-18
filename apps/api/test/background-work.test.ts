import type { WorkRunner } from "@family-agenda/application";
import type { RawMessageId, SourceId } from "@family-agenda/domain";
import { describe, expect, it } from "vitest";
import { createDueWork, type ExtractionAccess, type SourcePolling } from "@family-agenda/application";
import { logDueWork, startBackgroundWork } from "../src/background-work";

const source = "s1" as SourceId;
const message = "m1" as RawMessageId;

describe("logging what due work did", () => {
  it("writes each failure and refusal, one line each", () => {
    const lines: string[] = [];
    logDueWork(
      {
        polled: { ok: true, report: {
          ran: [],
          failed: [{ sourceId: source, kind: "temporary", message: "timed out" }],
          refused: [{ sourceId: source, attributes: ["a", "b"] }],
          invalid: [{ sourceId: source, externalId: "e1", problems: ["no title", "no date"] }],
          lost: [source],
        } },
        extracted: { ok: true, report: {
          extracted: [],
          failed: [{ messageId: message, problem: "unreachable", message: "no answer" }],
          dropped: [{ messageId: message, title: null, problem: "date-mismatch" }],
          gaveUp: [message],
        } },
      },
      { warn: (line) => lines.push(line), error: (line) => lines.push(line) },
    );

    expect(lines).toEqual([
      "Source s1 failed (temporary): timed out",
      "Source s1 named Source Attributes it never declared or had archived, so those records are refused: a, b",
      "Source s1 states an invalid Item for e1, which is not written: no title; no date",
      "Source s1 lost its turn to another process during its run, which is not recorded",
      "Extracting message m1 failed (unreachable): no answer",
      "Extracting message m1 failed too often; it is no longer read until an Admin retries it",
      'An Item "" of message m1 failed a check twice and is not written: date-mismatch',
    ]);
  });
});

describe("scheduling the worker's work", () => {
  it("logs work that fails, and goes on", async () => {
    const runs = new Map<string, () => Promise<void>>();
    const schedule: WorkRunner = {
      every: (name, _cron, run) => Promise.resolve(void runs.set(name, run)),
    };
    const broken = () => Promise.reject(new Error("database gone"));
    const errors: [string, unknown][] = [];
    await startBackgroundWork(
      { dueWork: { run: broken }, retention: { purge: broken }, secretSweep: { sweep: broken } },
      schedule,
      { warn: () => {}, error: (line, error) => errors.push([line, error]) },
    );

    for (const run of runs.values()) await run();

    expect(errors.map(([line]) => line)).toEqual([
      "Running due Sources and Extraction failed:",
      "Purging messages past their retention failed:",
      "Removing secrets nothing refers to failed:",
    ]);
  });
});

describe("due work", () => {
  it("still extracts when polling fails, and logs each failure as before", async () => {
    let extracted = false;
    const report = await createDueWork({
      polling: { pollDue: () => Promise.reject(new Error("database gone")) } as unknown as SourcePolling,
      extraction: {
        extractPending: () => {
          extracted = true;
          return Promise.reject(new Error("still gone"));
        },
      } as unknown as ExtractionAccess,
    }).run();
    const errors: string[] = [];
    logDueWork(report, { warn: () => {}, error: (line) => errors.push(line) });

    expect(extracted).toBe(true);
    expect(errors).toEqual(["Polling Sources failed:", "Extracting messages failed:"]);
  });
});

describe("the sweep", () => {
  it("runs when the worker starts, and every day", async () => {
    const scheduled: { name: string; cron: string; atStart: boolean }[] = [];
    const schedule: WorkRunner = {
      every: (name, cron, _run, options) => Promise.resolve(void scheduled.push({ name, cron, atStart: options?.atStart ?? false })),
    };
    const idle = () => Promise.reject(new Error("not run"));
    await startBackgroundWork({ dueWork: { run: idle }, retention: { purge: idle }, secretSweep: { sweep: idle } }, schedule, { warn: () => {}, error: () => {} });

    expect(scheduled).toEqual([
      { name: "due-work", cron: "* * * * *", atStart: false },
      { name: "purge", cron: "0 * * * *", atStart: false },
      { name: "secret-sweep", cron: "17 3 * * *", atStart: true },
    ]);
  });
});
