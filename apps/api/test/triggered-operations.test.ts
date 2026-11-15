import type { DueWorkReport } from "@family-agenda/application";
import { describe, expect, it } from "vitest";
import type { BackgroundWork } from "../src/background-work";
import { createTriggerApp } from "../src/triggered-operations";

const emptyReport: DueWorkReport = {
  polled: { ok: true, report: { ran: [], failed: [], refused: [], invalid: [], lost: [] } },
  extracted: { ok: true, report: { extracted: [], failed: [], dropped: [] } },
};

const fakeWork = (overrides: Partial<{ run: () => Promise<DueWorkReport>; purge: () => Promise<{ purged: number; deleted: number }>; sweep: () => Promise<number> }> = {}): BackgroundWork => ({
  dueWork: { run: overrides.run ?? (() => Promise.resolve(emptyReport)) },
  retention: { purge: overrides.purge ?? (() => Promise.resolve({ purged: 2, deleted: 3 })) },
  secretSweep: { sweep: overrides.sweep ?? (() => Promise.resolve(4)) },
});

const trigger = (app: ReturnType<typeof createTriggerApp>, name: string, headers: Record<string, string> = {}) =>
  app.request(`/operations/${name}`, { method: "POST", headers });

describe("triggered operations", () => {
  it("lists the operations it offers", async () => {
    const response = await createTriggerApp(fakeWork(), { token: null }).request("/operations");

    expect(await response.json()).toEqual({ operations: ["due-work", "purge", "secret-sweep"] });
  });

  it("answers the purge and the sweep with what they did", async () => {
    const app = createTriggerApp(fakeWork(), { token: null });

    expect(await (await trigger(app, "purge")).json()).toEqual({ purged: 2, deleted: 3 });
    expect(await (await trigger(app, "secret-sweep")).json()).toEqual({ removed: 4 });
  });

  it("answers due work with each step, a failed one by its error's message", async () => {
    const app = createTriggerApp(fakeWork({ run: () => Promise.resolve({ ...emptyReport, polled: { ok: false, error: new Error("database gone") } }) }), { token: null });

    const response = await trigger(app, "due-work");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ polled: { ok: false, error: "database gone" }, extracted: emptyReport.extracted });
  });

  it("names an error that is no Error by its text", async () => {
    const app = createTriggerApp(fakeWork({ run: () => Promise.resolve({ ...emptyReport, extracted: { ok: false, error: "gone" } }) }), { token: null });

    expect(await (await trigger(app, "due-work")).json()).toMatchObject({ extracted: { ok: false, error: "gone" } });
  });

  it("lets a trigger during a run wait for that run instead of starting another", async () => {
    let runs = 0;
    let finish: (report: DueWorkReport) => void = () => {};
    const app = createTriggerApp(fakeWork({ run: () => {
      runs++;
      return new Promise((resolve) => (finish = resolve));
    } }), { token: null });

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

  it("answers 500 when an operation throws", async () => {
    const app = createTriggerApp(fakeWork({ purge: () => Promise.reject(new Error("disk gone")) }), { token: null });

    const response = await trigger(app, "purge");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "failed" });
  });

  it("knows no other operation, nor one inherited from Object", async () => {
    const app = createTriggerApp(fakeWork(), { token: null });

    expect((await trigger(app, "toString")).status).toBe(404);
    expect((await trigger(app, "reboot")).status).toBe(404);
    expect((await app.request("/elsewhere")).status).toBe(404);
  });

  it("asks for the token when one is set", async () => {
    let swept = 0;
    const app = createTriggerApp(fakeWork({ sweep: () => Promise.resolve(++swept) }), { token: "s3cret-token" });

    expect((await trigger(app, "secret-sweep")).status).toBe(401);
    expect((await trigger(app, "secret-sweep", { authorization: "Bearer wrong" })).status).toBe(401);
    expect(swept).toBe(0);
    expect((await trigger(app, "secret-sweep", { authorization: "Bearer s3cret-token" })).status).toBe(200);
    expect(swept).toBe(1);
  });
});
