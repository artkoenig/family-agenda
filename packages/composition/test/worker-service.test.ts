import { describe, expect, it } from "vitest";
import type { Worker } from "../src/boot";
import { createWorkerService, type FamilyDatabase } from "../src/worker-service";

const familyAt = (databaseUrl: string): FamilyDatabase => ({ databaseUrl, masterKey: Buffer.alloc(32), blobDirectory: "/blobs", timeZone: "UTC" });
const nextDueAt = new Date("2026-11-08T10:00:00Z");

function fakeWorker(name: string, events: string[], pollDue: () => Promise<unknown> = () => Promise.resolve({ polled: [name] })) {
  return {
    polling: { pollDue },
    extraction: { extractPending: () => Promise.resolve({ extracted: [name] }) },
    dueWork: { nextDueAt: () => Promise.resolve(nextDueAt) },
    cleanup: { run: () => Promise.resolve({ purged: 0, deleted: 0, swept: 0 }) },
    close: () => {
      events.push(`close ${name}`);
      return Promise.resolve();
    },
  } as unknown as Worker;
}

describe("the worker's work for many Families", () => {
  it("boots each Family once, on its first trigger, and works on its own database", async () => {
    const events: string[] = [];
    const service = createWorkerService((family) => {
      events.push(`boot ${family.databaseUrl}`);
      return Promise.resolve(fakeWorker(family.databaseUrl, events));
    });

    expect(await service.poll(familyAt("a"))).toEqual({ report: { polled: ["a"] }, nextDueAt });
    expect(await service.extract(familyAt("a"))).toEqual({ report: { extracted: ["a"] }, nextDueAt });
    expect(await service.poll(familyAt("b"))).toEqual({ report: { polled: ["b"] }, nextDueAt });
    expect(await service.cleanup(familyAt("b"))).toEqual({ purged: 0, deleted: 0, swept: 0 });

    expect(events).toEqual(["boot a", "boot b"]);
    await service.close();
    expect(events.slice(2).sort()).toEqual(["close a", "close b"]);
  });

  it("answers a trigger while the same work of the same Family runs with that run's result", async () => {
    let calls = 0;
    let finish: (value: unknown) => void = () => {};
    const service = createWorkerService(() =>
      Promise.resolve(
        fakeWorker("a", [], () => {
          calls += 1;
          return calls === 1 ? new Promise((resolve) => (finish = resolve)) : Promise.resolve({ polled: ["again"] });
        }),
      ),
    );

    const first = service.poll(familyAt("a"));
    const second = service.poll(familyAt("a"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish({ polled: ["once"] });

    expect(await first).toEqual(await second);
    expect(calls).toBe(1);
    await service.poll(familyAt("a"));
    expect(calls).toBe(2);
  });

  it("boots a Family that failed to boot again on its next trigger", async () => {
    let attempts = 0;
    const service = createWorkerService(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("database down")) : Promise.resolve(fakeWorker("a", []));
    });

    await expect(service.poll(familyAt("a"))).rejects.toThrow("database down");
    expect((await service.poll(familyAt("a"))).report).toEqual({ polled: ["a"] });
    await service.close();
  });
});
