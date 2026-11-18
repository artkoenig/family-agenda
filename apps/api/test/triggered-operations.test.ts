import type { DueWorkReport } from "@family-agenda/application";
import { describe, expect, it } from "vitest";
import type { WorkLog } from "../src/background-work";
import type { AddressInfo } from "node:net";
import { createTriggerApp, serveTriggers, type TriggeredWork } from "../src/triggered-operations";

const emptyReport: DueWorkReport = {
  polled: { ok: true, report: { ran: [], failed: [], refused: [], invalid: [], lost: [] } },
  extracted: { ok: true, report: { extracted: [], failed: [], dropped: [], gaveUp: [] } },
};

type Overrides = {
  run: () => Promise<DueWorkReport>;
  purge: () => Promise<{ purged: number; deleted: number }>;
  sweep: () => Promise<number>;
};
const fakeWork = (overrides: Partial<Overrides> = {}): TriggeredWork => ({
  dueWork: { run: overrides.run ?? (() => Promise.resolve(emptyReport)) },
  retention: { purge: overrides.purge ?? (() => Promise.resolve({ purged: 2, deleted: 3 })) },
  secretSweep: { sweep: overrides.sweep ?? (() => Promise.resolve(4)) },
});

const token = "s3cret-token";
const bearer = { authorization: `Bearer ${token}` };
const silent: WorkLog = { warn: () => {}, error: () => {} };
const appOf = (work: TriggeredWork, log = silent) => createTriggerApp(work, { token, log });
const trigger = (app: ReturnType<typeof createTriggerApp>, name: string, headers: Record<string, string> = bearer) =>
  app.request(`/operations/${name}`, { method: "POST", headers });

describe("triggered operations", () => {
  it("lists the operations it offers", async () => {
    const response = await appOf(fakeWork()).request("/operations", { headers: bearer });

    expect(await response.json()).toEqual({ operations: ["due-work", "purge", "secret-sweep"] });
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

  it("knows no other operation, nor one inherited from Object", async () => {
    const app = appOf(fakeWork());

    expect((await trigger(app, "toString")).status).toBe(404);
    expect((await trigger(app, "reboot")).status).toBe(404);
    expect((await trigger(app, "enter-admin")).status).toBe(404);
    expect((await trigger(app, "reset-admin-password")).status).toBe(404);
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
