import { describe, expect, it } from "vitest";
import type { Worker } from "../src/boot";
import { createWorkerLoop, logDueWorkReport } from "../src/worker-loop";

function workerWith(parts: { reconcile?: () => Promise<unknown> }) {
  const calls = { stopped: 0 };
  const worker = {
    dueWork: { idle: () => Promise.resolve() },
    services: {
      reconcile: parts.reconcile ?? (() => Promise.resolve({ failed: [] })),
      stop: () => {
        calls.stopped += 1;
        return Promise.resolve();
      },
    },
  } as unknown as Worker;
  return { worker, calls };
}

const recorder = () => {
  const lines: string[] = [];
  return { lines, log: { warn: (m: string) => lines.push(`warn ${m}`), error: (m: string) => lines.push(`error ${m}`) } };
};

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

    const failing = recorder();
    logDueWorkReport({ polling: null, extraction: null, errors: [{ step: "polling", error: new Error("x") }, { step: "extraction", error: new Error("y") }] }, failing.log);
    expect(failing.lines).toEqual(["error Polling Sources failed:", "error Extracting messages failed:"]);
  });
});

describe("the service supervision of one Worker", () => {
  it("logs a failure of services that stays once, and again when it changes or comes back", async () => {
    const { lines, log } = recorder();
    let failed: { sourceTypeId: string; message: string }[] = [{ sourceTypeId: "a", message: "x" }];
    const loop = createWorkerLoop(workerWith({ reconcile: () => Promise.resolve({ failed }) }).worker, log);

    await loop.reconcile();
    await loop.reconcile();
    failed = [];
    await loop.reconcile();
    failed = [{ sourceTypeId: "a", message: "x" }];
    await loop.reconcile();

    expect(lines).toEqual(["warn Services of Source Type a failed: x", "warn Services of Source Type a failed: x"]);
  });

  it("reports a reconcile that throws, and stops the services once the runs are over", async () => {
    const { lines, log } = recorder();
    const { worker, calls } = workerWith({ reconcile: () => Promise.reject(new Error("boom")) });
    const loop = createWorkerLoop(worker, log);

    await loop.reconcile();
    await loop.stop();

    expect(lines).toEqual(["error Reconciling the services of Source Types failed:"]);
    expect(calls.stopped).toBe(1);
  });
});
