import { openAgendaAccess } from "@family-agenda/application";
import type { Origin } from "../support/test-source-plugin";
import type { SourceId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls } from "../support/test-source-plugin";

const minutes = 60 * 1000;
const hours = 60 * minutes;
const days = 24 * hours;

const announcement = (externalId: string): Origin => ({
  externalId,
  sender: "School", attributes: ["main"],
  content: { kind: "stated", stated: { kind: "event", title: "Parents' evening", span: { allDay: true, firstDay: "2026-09-20", lastDay: "2026-09-20" }, place: null, cancelled: false } },
});

describe("Source health", () => {
  let instance: TestInstance;
  let source: SourceId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootForTest({ sourcePlugins: [{ sourceTypeId: "school-portal" }] });
    await instance.app.sourceTypes.enable("school-portal");
    const added = await instance.app.sources.add({
      sourceTypeId: "school-portal",
      plain: { url: "https://portal.example.org" },
      secrets: {},
    });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    source = added.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The worker's next tick, once the Source's 10-minute interval has passed. */
  const tick = async (after = 10 * minutes) => {
    instance.clock.advance(after);
    await instance.app.polling.pollDue();
  };

  const health = async () => (await instance.app.sources.list()).find((s) => s.id === source)?.health;

  it("awaits a read until it has run, and again once an Admin changed it", async () => {
    expect((await health())?.awaitingRead).toBe(true);

    await tick();
    expect((await health())?.awaitingRead).toBe(false);

    const edited = await instance.app.sources.edit(source, { plain: { url: "https://other.example.org" }, secrets: {} });
    expect(edited.ok).toBe(true);
    expect((await health())?.awaitingRead).toBe(true);
  });

  it("is OK once it has run successfully, with the time of that run", async () => {
    await tick();

    expect(await health()).toEqual({
      status: "ok",
      problem: null,
      lastSuccessAt: new Date("2026-09-14T07:10:00Z"),
      invalidRecords: [],
      unknownAttributes: [], settingUp: null,
      awaitingRead: false,
      failedMessages: 0,
    });
  });

  it("is Failing at once on an error the plugin declares definite", async () => {
    await tick();
    testPluginControls.failNext("school-portal", "definite");
    await tick();

    expect(await health()).toEqual({
      status: "failing",
      problem: { kind: "run-failed", message: "school-portal failed" },
      lastSuccessAt: new Date("2026-09-14T07:10:00Z"),
      invalidRecords: [],
      unknownAttributes: [], settingUp: null,
      awaitingRead: false,
      failedMessages: 0,
    });
  });

  it("shows temporary errors on an OK Source, and is Failing once they have lasted 6 hours", async () => {
    await tick();
    testPluginControls.failNext("school-portal", "temporary");
    await tick();
    expect(await health()).toEqual({
      status: "ok",
      problem: { kind: "run-failed", message: "school-portal failed" },
      lastSuccessAt: new Date("2026-09-14T07:10:00Z"),
      invalidRecords: [],
      unknownAttributes: [], settingUp: null,
      awaitingRead: false,
      failedMessages: 0,
    });

    testPluginControls.failNext("school-portal", "temporary");
    await tick(5 * hours + 59 * minutes);
    expect((await health())?.status).toBe("ok");

    testPluginControls.failNext("school-portal", "temporary");
    await tick(1 * minutes);
    expect((await health())?.status).toBe("failing");
  });

  it("is OK again after a successful run", async () => {
    testPluginControls.failNext("school-portal", "definite");
    await tick();
    expect(await health()).toMatchObject({ status: "failing", lastSuccessAt: null, invalidRecords: [], unknownAttributes: [], settingUp: null, awaitingRead: false, failedMessages: 0 });

    await tick();

    expect(await health()).toEqual({ status: "ok", problem: null, lastSuccessAt: new Date("2026-09-14T07:20:00Z"), invalidRecords: [], unknownAttributes: [], settingUp: null, awaitingRead: false, failedMessages: 0 });
  });

  it("stays Failing after a definite error until a run succeeds, whatever errors follow", async () => {
    testPluginControls.failNext("school-portal", "definite");
    await tick();
    testPluginControls.failNext("school-portal", "temporary");
    await tick();

    expect(await health()).toEqual({
      status: "failing",
      problem: { kind: "run-failed", message: "school-portal failed" },
      lastSuccessAt: null,
      invalidRecords: [],
      unknownAttributes: [], settingUp: null,
      awaitingRead: false,
      failedMessages: 0,
    });
  });

  describe("still being set up", () => {
    const text = "Waiting for the account to be linked.";
    beforeEach(() => { testPluginControls.settingUp("school-portal", text); });
    afterEach(() => { testPluginControls.settingUp("school-portal", null); });

    it("tells what it waits for, without an error and without having been read", async () => {
      await tick();

      expect(await health()).toMatchObject({ status: "ok", problem: null, settingUp: text, lastSuccessAt: null });
    });

    it("runs again within half a minute, and is ready once a run says so", async () => {
      await tick();
      testPluginControls.settingUp("school-portal", null);
      await tick(29_000);
      expect((await health())?.settingUp).toBe(text);

      await tick(1_000);
      const ready = await health();
      expect(ready?.settingUp).toBeNull();
      expect(ready?.lastSuccessAt).not.toBeNull();
    });

    it("clears an error, and is cleared by one", async () => {
      testPluginControls.failNext("school-portal", "definite");
      await tick();
      expect(await health()).toMatchObject({ status: "failing", settingUp: null });

      await tick();
      expect(await health()).toMatchObject({ status: "ok", problem: null, settingUp: text });

      testPluginControls.failNext("school-portal", "definite");
      await tick();
      expect(await health()).toMatchObject({ status: "failing", settingUp: null });
    });

    it("keeps when it was last read, if it was set up before", async () => {
      testPluginControls.settingUp("school-portal", null);
      await tick();
      const read = (await health())?.lastSuccessAt;
      testPluginControls.settingUp("school-portal", text);
      await tick();

      expect(await health()).toMatchObject({ settingUp: text, lastSuccessAt: read });
    });
  });

  it("is Silent after 14 days without a new Origin, and OK again once one comes", async () => {
    testPluginControls.emit("school-portal", [announcement("evening")]);
    await tick();

    await tick(14 * days - 1 * minutes);
    expect((await health())?.status).toBe("ok");

    testPluginControls.emit("school-portal", [announcement("evening")]);
    await tick(1 * minutes);
    expect((await health())?.status, "an Origin seen before is not new").toBe("silent");

    testPluginControls.emit("school-portal", [announcement("trip")]);
    await tick();
    expect((await health())?.status).toBe("ok");
  });

  it("counts Silent from when it was added while no Origin has come", async () => {
    await tick(14 * days);

    expect((await health())?.status).toBe("silent");
  });

  it("is never Silent when its Source Type does not declare it", async () => {
    await instance.installPlugin({ sourceTypeId: "calendar", silentApplies: false });
    await instance.restart();
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://cal.example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");

    await tick(30 * days);

    const calendar = (await instance.app.sources.list()).find((s) => s.id === added.id);
    expect(calendar?.health.status).toBe("ok");
  });

  it("is Failing while its plugin is not installed, keeping its Items, and resumes from its sync cursor once reinstalled", async () => {
    testPluginControls.emit("school-portal", [announcement("evening")]);
    await tick();
    expect(testPluginControls.runs("school-portal").at(-1)?.syncCursor).toBeNull();

    instance.uninstallPlugin("school-portal");
    await instance.restart();
    await tick();

    expect(await health()).toEqual({
      status: "failing",
      problem: { kind: "not-installed" },
      lastSuccessAt: new Date("2026-09-14T07:10:00Z"),
      invalidRecords: [],
      unknownAttributes: [], settingUp: null,
      awaitingRead: false,
      failedMessages: 0,
    });
    const [items] = await instance.query("SELECT count(*)::int AS items FROM item");
    expect(items).toEqual({ items: 1 });

    await instance.installPlugin({ sourceTypeId: "school-portal" });
    await instance.restart();
    await tick();

    expect(testPluginControls.runs("school-portal").at(-1)?.syncCursor).toBe("1");
    expect(await health()).toEqual({ status: "ok", problem: null, lastSuccessAt: new Date("2026-09-14T07:30:00Z"), invalidRecords: [], unknownAttributes: [], settingUp: null, awaitingRead: false, failedMessages: 0 });
  });

  it("tells every Agenda it may be out of date while a Source is Failing, and only then", async () => {
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 7 });
    if (!created.ok) throw new Error("creating failed");
    const outOfDate = async () => (await instance.app.agendas.open(created.id, { access: openAgendaAccess }))?.mayBeOutOfDate;

    testPluginControls.failNext("school-portal", "temporary");
    await tick();
    expect(await outOfDate(), "a temporary error alone").toBe(false);

    await tick(14 * days);
    expect(await outOfDate(), "a Silent Source").toBe(false);

    testPluginControls.failNext("school-portal", "definite");
    await tick();
    expect(await outOfDate()).toBe(true);

    await tick();
    expect(await outOfDate()).toBe(false);
  });
});
