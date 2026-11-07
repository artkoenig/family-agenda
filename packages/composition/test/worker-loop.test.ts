import { describe, expect, it } from "vitest";
import type { Worker } from "../src/boot";
import { createWorkerLoop } from "../src/worker-loop";

const emptyReport = { failed: [], refused: [], invalid: [], dropped: [] };

function workerWith(parts: { pollDue?: () => Promise<unknown>; extractPending?: () => Promise<unknown>; reconcile?: () => Promise<unknown> }) {
  const calls = { stopped: 0 };
  const worker = {
    polling: { pollDue: parts.pollDue ?? (() => Promise.resolve(emptyReport)) },
    extraction: { extractPending: parts.extractPending ?? (() => Promise.resolve(emptyReport)) },
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

describe("the background work of one Worker", () => {
  it("skips a tick while the last one is still running", async () => {
    let polls = 0;
    let finish = () => {};
    const { worker } = workerWith({
      pollDue: () => {
        polls += 1;
        return new Promise((resolve) => {
          finish = () => { resolve(emptyReport); };
        });
      },
    });
    const loop = createWorkerLoop(worker, recorder().log);

    const first = loop.poll();
    const second = loop.poll();
    finish();
    await Promise.all([first, second]);
    const third = loop.poll();
    finish();
    await third;

    expect(polls).toBe(2);
  });

  it("reports what polling and extraction found, and what made them fail", async () => {
    const { lines, log } = recorder();
    const { worker } = workerWith({
      pollDue: () => Promise.resolve({ failed: [{ sourceId: "s1", kind: "network", message: "down" }], refused: [{ sourceId: "s2", attributes: ["a"] }], invalid: [{ sourceId: "s3", externalId: "e", problems: ["p"] }] }),
      extractPending: () => Promise.resolve({ failed: [{ messageId: "m1", problem: "llm", message: "bad" }], dropped: [{ messageId: "m2", title: null, problem: "check" }] }),
    });

    await createWorkerLoop(worker, log).poll();

    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("warn Source s1 failed (network): down");

    const failing = recorder();
    await createWorkerLoop(workerWith({ pollDue: () => Promise.reject(new Error("x")), extractPending: () => Promise.reject(new Error("y")) }).worker, failing.log).poll();
    expect(failing.lines).toEqual(["error Polling Sources failed:", "error Extracting messages failed:"]);
  });

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
