import type { DueWorkReport } from "@family-agenda/application";
import { describe, expect, it } from "vitest";
import { FamilyIdConflictError } from "@family-agenda/adapters";
import type { WorkLog } from "../src/background-work";
import type { AddressInfo } from "node:net";
import { createTriggerApp, serveTriggers, type TriggeredWork } from "../src/triggered-operations";

const emptyReport: DueWorkReport = {
  polled: { ok: true, report: { ran: [], failed: [], refused: [], invalid: [], lost: [] } },
  extracted: { ok: true, report: { extracted: [], failed: [], dropped: [] } },
};

type Overrides = {
  run: () => Promise<DueWorkReport>;
  purge: () => Promise<{ purged: number; deleted: number }>;
  sweep: () => Promise<number>;
  prepare: (familyId?: string) => Promise<{ familyId: string }>;
};
const familyId = "0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e";
const fakeWork = (overrides: Partial<Overrides> = {}): TriggeredWork => ({
  prepare: overrides.prepare ?? ((given) => Promise.resolve({ familyId: given ?? familyId })),
  dueWork: { run: overrides.run ?? (() => Promise.resolve(emptyReport)) },
  retention: { purge: overrides.purge ?? (() => Promise.resolve({ purged: 2, deleted: 3 })) },
  secretSweep: { sweep: overrides.sweep ?? (() => Promise.resolve(4)) },
});

const token = "s3cret-token";
const bearer = { authorization: `Bearer ${token}` };
const silent: WorkLog = { warn: () => {}, error: () => {} };
const appOf = (work: TriggeredWork, log = silent) => createTriggerApp(work, { token, log });
const trigger = (app: ReturnType<typeof createTriggerApp>, name: string, headers: Record<string, string> = bearer, body?: string) =>
  app.request(`/operations/${name}`, { method: "POST", headers, ...(body === undefined ? {} : { body }) });

describe("triggered operations", () => {
  it("lists the operations it offers", async () => {
    const response = await appOf(fakeWork()).request("/operations", { headers: bearer });

    expect(await response.json()).toEqual({ operations: ["due-work", "purge", "secret-sweep", "prepare-family"] });
  });

  it("answers the purge and the sweep with what they did", async () => {
    const app = appOf(fakeWork());

    expect(await (await trigger(app, "purge")).json()).toEqual({ purged: 2, deleted: 3 });
    expect(await (await trigger(app, "secret-sweep")).json()).toEqual({ removed: 4 });
  });

  it("answers due work with each step, a failed one by its error's message", async () => {
    const app = appOf(fakeWork({ run: () => Promise.resolve({ ...emptyReport, polled: { ok: false, error: new Error("database gone") } }) }));

    const response = await trigger(app, "due-work");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ polled: { ok: false, error: "database gone" }, extracted: emptyReport.extracted });
  });

  it("names an error that is no Error by its text", async () => {
    const app = appOf(fakeWork({ run: () => Promise.resolve({ ...emptyReport, extracted: { ok: false, error: "gone" } }) }));

    expect(await (await trigger(app, "due-work")).json()).toMatchObject({ extracted: { ok: false, error: "gone" } });
  });

  it("lets a trigger during a run wait for that run instead of starting another", async () => {
    let runs = 0;
    let finish: (report: DueWorkReport) => void = () => {};
    const app = appOf(fakeWork({ run: () => {
      runs++;
      return new Promise((resolve) => (finish = resolve));
    } }));

    const first = trigger(app, "due-work");
    const second = trigger(app, "due-work");
    await new Promise((resolve) => setTimeout(resolve, 5));
    finish(emptyReport);
    await Promise.all([first, second]);
    expect(runs).toBe(1);

    const third = trigger(app, "due-work");
    await new Promise((resolve) => setTimeout(resolve, 5));
    finish(emptyReport);
    await third;
    expect(runs).toBe(2);
  });

  it("answers 500 when an operation throws, and logs it as the worker does", async () => {
    const errors: string[] = [];
    const app = appOf(fakeWork({ purge: () => Promise.reject(new Error("disk gone")) }), { warn: () => {}, error: (line: string) => void errors.push(line) });

    const response = await trigger(app, "purge");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "failed" });
    expect(errors).toEqual(["Purging messages past their retention failed:"]);
  });

  it("logs what due work failed at, as the worker does", async () => {
    const errors: string[] = [];
    const app = appOf(fakeWork({ run: () => Promise.resolve({ ...emptyReport, polled: { ok: false, error: new Error("gone") } }) }), { warn: () => {}, error: (line: string) => void errors.push(line) });

    await trigger(app, "due-work");

    expect(errors).toEqual(["Polling Sources failed:"]);
  });

  it("prepares the Family, with the Family id a body names or without one", async () => {
    const given: (string | undefined)[] = [];
    const app = appOf(fakeWork({ prepare: (id) => (given.push(id), Promise.resolve({ familyId })) }));

    expect(await (await trigger(app, "prepare-family")).json()).toEqual({ familyId });
    expect(await (await trigger(app, "prepare-family", bearer, "{}")).json()).toEqual({ familyId });
    expect(await (await trigger(app, "prepare-family", bearer, JSON.stringify({ familyId: familyId.toUpperCase() }))).json()).toEqual({ familyId });
    expect(given).toEqual([undefined, undefined, familyId]);
  });

  it("refuses a Family id that is no UUID, and a body that is no JSON, without preparing", async () => {
    let prepared = 0;
    const app = appOf(fakeWork({ prepare: () => (prepared++, Promise.resolve({ familyId })) }));

    const invalid = await trigger(app, "prepare-family", bearer, JSON.stringify({ familyId: 7 }));
    const notJson = await trigger(app, "prepare-family", bearer, "{");

    expect([invalid.status, await invalid.json()]).toEqual([400, { error: "invalid-family-id" }]);
    expect([notJson.status, await notJson.json()]).toEqual([400, { error: "invalid-body" }]);
    expect(prepared).toBe(0);
  });

  it("answers 409 with the Family id the database holds when another one is given", async () => {
    const other = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
    const app = appOf(fakeWork({ prepare: (id) => Promise.reject(new FamilyIdConflictError(familyId, id ?? "")) }));

    const response = await trigger(app, "prepare-family", bearer, JSON.stringify({ familyId: other }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "family-id-differs", familyId });
  });

  it("answers 500 when preparing fails otherwise, and logs it", async () => {
    const errors: string[] = [];
    const app = appOf(fakeWork({ prepare: () => Promise.reject(new Error("database gone")) }), { warn: () => {}, error: (line: string) => void errors.push(line) });

    expect((await trigger(app, "prepare-family")).status).toBe(500);
    expect(errors).toEqual(["Preparing the Family failed:"]);
  });

  it("lets prepares in one api take turns, also after one failed", async () => {
    const steps: string[] = [];
    let calls = 0;
    const app = appOf(fakeWork({ prepare: async () => {
      const call = ++calls;
      steps.push(`start ${call}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      steps.push(`end ${call}`);
      if (call === 1) throw new Error("first fails");
      return { familyId };
    } }));

    const statuses = await Promise.all([trigger(app, "prepare-family"), trigger(app, "prepare-family")].map(async (r) => (await r).status));

    expect(statuses).toEqual([500, 200]);
    expect(steps).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("knows no other operation, nor one inherited from Object", async () => {
    const app = appOf(fakeWork());

    expect((await trigger(app, "toString")).status).toBe(404);
    expect((await trigger(app, "reboot")).status).toBe(404);
    expect((await app.request("/elsewhere", { headers: bearer })).status).toBe(404);
  });

  it("asks every request for the token", async () => {
    let swept = 0;
    const app = appOf(fakeWork({ sweep: () => Promise.resolve(++swept) }));

    expect((await trigger(app, "secret-sweep", {})).status).toBe(401);
    expect((await app.request("/operations")).status).toBe(401);
    expect((await trigger(app, "secret-sweep", { authorization: "Bearer wrong" })).status).toBe(401);
    expect(swept).toBe(0);
    expect((await trigger(app, "secret-sweep", { authorization: "Bearer s3cret-token" })).status).toBe(200);
    expect(swept).toBe(1);
  });
});

describe("the listener of triggered operations", () => {
  it("does not listen without a token, and says so once", () => {
    const lines: string[] = [];

    expect(serveTriggers(fakeWork(), { port: 0, token: null }, { ...silent, info: (line) => lines.push(line) })).toBeNull();
    expect(lines).toEqual(["Triggered operations are off: TRIGGER_TOKEN is not set"]);
  });

  it("listens with a token on its own port, asking for it", async () => {
    const lines: string[] = [];
    const server = serveTriggers(fakeWork(), { port: 0, token }, { ...silent, info: (line) => lines.push(line) });
    if (!server) throw new Error("not listening");
    try {
      await new Promise((resolve) => server.once("listening", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/operations/secret-sweep`;

      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect(await (await fetch(url, { method: "POST", headers: bearer })).json()).toEqual({ removed: 4 });
      expect(lines[0]).toMatch(/^Triggered operations listening on port \d+$/);
    } finally {
      server.close();
    }
  });
});
