import type { WorkSchedule } from "@family-agenda/application";
import type { RawMessageId, SourceId } from "@family-agenda/domain";
import { describe, expect, it } from "vitest";
import { logDueWork, scheduleWork } from "../src/scheduled-work";

const source = "s1" as SourceId;
const message = "m1" as RawMessageId;

describe("logging what due work did", () => {
  it("writes each failure and refusal, one line each", () => {
    const lines: string[] = [];
    logDueWork(
      {
        polled: {
          ran: [],
          failed: [{ sourceId: source, kind: "temporary", message: "timed out" }],
          refused: [{ sourceId: source, attributes: ["a", "b"] }],
          invalid: [{ sourceId: source, externalId: "e1", problems: ["no title", "no date"] }],
        },
        extracted: {
          extracted: [],
          failed: [{ messageId: message, problem: "unreachable", message: "no answer" }],
          dropped: [{ messageId: message, title: null, problem: "date-mismatch" }],
        },
      },
      { warn: (line) => lines.push(line), error: (line) => lines.push(line) },
    );

    expect(lines).toEqual([
      "Source s1 failed (temporary): timed out",
      "Source s1 named Source Attributes it never declared or had archived, so those records are refused: a, b",
      "Source s1 states an invalid Item for e1, which is not written: no title; no date",
      "Extracting message m1 failed (unreachable): no answer",
      'An Item "" of message m1 failed a check twice and is not written: date-mismatch',
    ]);
  });
});

describe("scheduling the worker's work", () => {
  it("logs work that fails, and goes on", async () => {
    const runs = new Map<string, () => Promise<void>>();
    const schedule: WorkSchedule = {
      every: (name, _cron, run) => Promise.resolve(void runs.set(name, run)),
      now: (name, run) => Promise.resolve(void runs.set(name, run)),
    };
    const broken = () => Promise.reject(new Error("database gone"));
    const errors: [string, unknown][] = [];
    await scheduleWork(
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
