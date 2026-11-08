import { describe, expect, it } from "vitest";
import { createWorkerHandler, WorkerClient } from "../src/worker-channel";
import type { FamilyDatabase, WorkerService } from "../src/worker-service";

const family: FamilyDatabase = { databaseUrl: "postgres://db/family", masterKey: Buffer.alloc(32, 7), blobDirectory: "/blobs", timeZone: "Europe/Berlin" };
const nextDueAt = new Date("2026-11-08T10:00:00Z");

function serviceRecording() {
  const seen: FamilyDatabase[] = [];
  const service: WorkerService = {
    poll: (f) => {
      seen.push(f);
      return Promise.resolve({ report: { polled: ["s1"], failed: [], invalid: [], refused: [] } as never, nextDueAt });
    },
    extract: () => Promise.resolve({ report: { extracted: [], dropped: [], failed: [] }, nextDueAt: null }),
    cleanup: () => Promise.reject(new Error("disk full")),
    close: () => Promise.resolve(),
  };
  return { service, seen };
}

const clientOf = (handler: (request: Request) => Promise<Response>, token = "token") =>
  new WorkerClient({ url: "http://worker:4200", token, fetch: (input, init) => handler(new Request(input, init)) });

describe("the channel api triggers the worker on", () => {
  it("carries the Family's database and the worker's report both ways", async () => {
    const { service, seen } = serviceRecording();
    const client = clientOf(createWorkerHandler(service, "token"));

    expect(await client.poll(family)).toEqual({ report: { polled: ["s1"], failed: [], invalid: [], refused: [] } as never, nextDueAt });
    expect(seen).toEqual([family]);
    expect(await client.extract(family)).toEqual({ report: { extracted: [], dropped: [], failed: [] }, nextDueAt: null });
  });

  it("reports work that failed in the worker", async () => {
    const client = clientOf(createWorkerHandler(serviceRecording().service, "token"));

    await expect(client.cleanup(family)).rejects.toThrow(/status 500: .*disk full/);
  });

  it("refuses a wrong token, an unknown path and a body without a Family", async () => {
    const handler = createWorkerHandler(serviceRecording().service, "token");
    const post = (path: string, body: string, token = "token") =>
      handler(new Request(`http://worker${path}`, { method: "POST", body, headers: { authorization: `Bearer ${token}` } }));

    await expect(clientOf(handler, "wrong").poll(family)).rejects.toThrow(/WORKER_TOKEN/);
    expect((await post("/elsewhere", "{}")).status).toBe(404);
    expect((await handler(new Request("http://worker/poll", { headers: { authorization: "Bearer token" } }))).status).toBe(404);
    expect((await post("/poll", "not json")).status).toBe(400);
    expect((await post("/poll", "null")).status).toBe(400);
    expect((await post("/poll", JSON.stringify({ databaseUrl: "x" }))).status).toBe(400);
  });

  it("says when the worker cannot be reached", async () => {
    const client = new WorkerClient({ url: "http://worker:4200", token: "t", fetch: () => Promise.reject(new Error("ECONNREFUSED")) });

    await expect(client.poll(family)).rejects.toThrow("The worker cannot be reached: ECONNREFUSED");
    const refusing = new WorkerClient({ url: "http://worker:4200", token: "t", fetch: () => Promise.reject(new Error("down")) });
    await expect(refusing.cleanup(family)).rejects.toThrow("The worker cannot be reached: down");
  });
});
