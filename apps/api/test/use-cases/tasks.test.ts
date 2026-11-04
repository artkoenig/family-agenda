import type { Origin } from "@family-agenda/source-sdk";
import { openAgendaAccess } from "@family-agenda/application";
import type { ItemId, LocalDate, AgendaId } from "@family-agenda/domain";
import ICAL from "ical.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { icsFeed } from "../../src/http/ics-feed";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extractedTask, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";
import { seedTasks, type SeededTask } from "../support/seed-task";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;
const days = 24 * 60 * minutes;

/** A Task a message sent at `sentAt` stated. */
const task = (key: string, sentAt: string, fields: Omit<SeededTask, "key" | "sentAt">): SeededTask => ({ key, sentAt, ...fields });

const sportsKit = task("kit", "2026-09-10T10:00:00Z", { title: "Bring sports kit", deadline: "2026-09-16", bring: ["Trainers", "Towel"] });

describe("Tasks", () => {
  let instance: TestInstance;
  let agenda: AgendaId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootForTest();
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "school" });
    await instance.restart();
    await instance.app.sourceTypes.enable("school");
    const added = await instance.app.sources.add({ sourceTypeId: "school", plain: { url: "https://school.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    agenda = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  /** Messages stating the Tasks were read. */
  const arrive = async (...tasks: SeededTask[]) => {
    await seedTasks((sql) => instance.query(sql), ...tasks);
  };

  /** The Agenda's pinned Tasks and those on each day, as `title (status)`. */
  const shown = async () => {
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    const label = (row: { title: string; status: string; cancelled: boolean }) =>
      `${row.title} (${row.status}${row.cancelled ? ", cancelled" : ""})`;
    return {
      pinned: page?.pinned.map(label),
      days: Object.fromEntries((page?.days ?? []).filter((day) => day.tasks.length > 0).map((day) => [day.date, day.tasks.map(label)])),
    };
  };

  it("shows a Task on its Deadline day, pins it once Due, and marks it Overdue after its Deadline", async () => {
    await arrive(sportsKit);
    expect(await shown()).toEqual({ pinned: [], days: { "2026-09-16": ["Bring sports kit (upcoming)"] } });

    instance.clock.advance(2 * days);
    expect(await shown()).toEqual({ pinned: ["Bring sports kit (due)"], days: {} });

    instance.clock.advance(1 * days);
    expect(await shown()).toEqual({ pinned: ["Bring sports kit (overdue)"], days: {} });

    instance.clock.advance(30 * days);
    expect(await shown()).toEqual({ pinned: ["Bring sports kit (overdue)"], days: {} });
  });

  it("pins a Task without a Deadline at once, Deadlines first", async () => {
    await arrive(
      task("form", "2026-09-10T10:00:00Z", { title: "Sign the trip form" }),
      task("library", "2026-09-10T10:00:00Z", { title: "Return library books", deadline: "2026-09-12" }),
    );

    expect(await shown()).toEqual({ pinned: ["Return library books (overdue)", "Sign the trip form (due)"], days: {} });

    instance.clock.advance(60 * days);
    expect((await shown()).pinned).toEqual(["Return library books (overdue)", "Sign the trip form (due)"]);
  });

  /** The id of the Task the Agenda pins or shows with the title. */
  const taskId = async (title: string) => {
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess, days: { first: "2026-09-01" as LocalDate, last: "2026-10-31" as LocalDate } });
    const all = [...(page?.pinned ?? []), ...(page?.days ?? []).flatMap((day) => day.tasks)];
    const found = all.find((row) => row.title === title);
    if (!found) throw new Error(`no Task ${title}`);
    return found.itemId;
  };

  it("unpins a Task ticked done from an Agenda, keeps it checked on its Deadline day, and pins it again when the tick is undone", async () => {
    await arrive(sportsKit);
    instance.clock.advance(3 * days);
    const kit = await taskId("Bring sports kit");

    expect(await instance.app.tasks.tickFromAgenda(agenda, kit, { done: true, access: openAgendaAccess })).toEqual({ ok: true });

    expect(await shown()).toEqual({ pinned: [], days: {} });
    const past = await openTimeline(instance.app, agenda, { access: openAgendaAccess, days: { first: "2026-09-16" as LocalDate, last: "2026-09-16" as LocalDate } });
    expect(past?.days[0]?.tasks).toMatchObject([{ title: "Bring sports kit", status: "done" }]);

    expect(await instance.app.tasks.tickFromAgenda(agenda, kit, { done: false, access: openAgendaAccess })).toEqual({ ok: true });
    expect((await shown()).pinned).toEqual(["Bring sports kit (overdue)"]);
  });

  it("keeps a Task without a Deadline on the day its message was sent once it is ticked done, not on the day it was ticked", async () => {
    await arrive(task("form", "2026-09-10T10:00:00Z", { title: "Sign the trip form" }));
    const form = await taskId("Sign the trip form");

    await instance.app.tasks.tickFromAgenda(agenda, form, { done: true, access: openAgendaAccess });

    expect(await shown()).toEqual({ pinned: [], days: {} });
    const sent = await openTimeline(instance.app, agenda, { access: openAgendaAccess, days: { first: "2026-09-10" as LocalDate, last: "2026-09-14" as LocalDate } });
    expect(sent?.days.map((day) => [day.date, day.tasks.map((row) => row.title)])).toEqual([
      ["2026-09-10", ["Sign the trip form"]],
      ["2026-09-11", []],
      ["2026-09-12", []],
      ["2026-09-13", []],
      ["2026-09-14", []],
    ]);
  });

  it("keeps when a Task was last ticked done, and forgets it when the tick is taken back", async () => {
    const created = await instance.app.agendas.create({ kind: "tasks", preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    const list = created.id;
    await arrive(sportsKit);
    const kit = await taskId("Bring sports kit");

    await instance.app.tasks.tickFromAgenda(agenda, kit, { done: true, access: openAgendaAccess });
    instance.clock.advance(5 * minutes);
    await instance.app.tasks.tickFromAgenda(list, kit, { done: false, access: openAgendaAccess });
    instance.clock.advance(5 * minutes);
    await instance.app.tasks.tickFromAgenda(list, kit, { done: true, access: openAgendaAccess });

    expect(await instance.query(`SELECT status, done_at FROM task WHERE item_id = '${kit}'`)).toEqual([
      { status: "done", done_at: new Date("2026-09-14T07:10:00Z") },
    ]);
    expect((await shown()).days).toEqual({ "2026-09-16": ["Bring sports kit (done)"] });
  });

  it("lists in a Task List those Due first, then those not Due yet, then those done in the last 30 days", async () => {
    const created = await instance.app.agendas.create({ kind: "tasks", preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    await arrive(
      sportsKit,
      task("form", "2026-09-10T10:00:00Z", { title: "Sign the trip form", deadline: "2026-09-12" }),
      task("old", "2026-07-01T10:00:00Z", { title: "Return the library book", deadline: "2026-07-03" }),
      task("photo", "2026-09-10T10:00:00Z", { title: "Say if a photo may be taken" }),
    );
    await instance.app.tasks.tickFromAgenda(created.id, await taskId("Say if a photo may be taken"), { done: true, access: openAgendaAccess });
    await instance.app.tasks.tickFromAgenda(created.id, await taskId("Return the library book"), { done: true, access: openAgendaAccess });

    const page = await instance.app.agendas.open(created.id, { access: openAgendaAccess });
    if (page?.kind !== "tasks") throw new Error("not a Task List");
    const titles = (rows: { title: string; status: string }[]) => rows.map((row) => `${row.title} (${row.status})`);

    expect(titles(page.due)).toEqual(["Sign the trip form (overdue)"]);
    expect(titles(page.upcoming)).toEqual(["Bring sports kit (upcoming)"]);
    expect(titles(page.done)).toEqual(["Say if a photo may be taken (done)"]);
  });

  it("adds nothing for a tick that changes nothing, and refuses what is no Task or no Agenda", async () => {
    await arrive(sportsKit, task("form", "2026-09-10T10:00:00Z", { title: "Sign the trip form" }));
    const kit = await taskId("Bring sports kit");

    await instance.app.tasks.tickFromAgenda(agenda, kit, { done: true, access: openAgendaAccess });
    instance.clock.advance(5 * minutes);
    await instance.app.tasks.tickFromAgenda(agenda, kit, { done: true, access: openAgendaAccess });
    expect(await instance.query(`SELECT done_at FROM task WHERE item_id = '${kit}'`)).toEqual([{ done_at: new Date("2026-09-14T07:00:00Z") }]);

    const refusing = { mayOpen: () => Promise.resolve(false) };
    const form = await taskId("Sign the trip form");
    expect(await instance.app.tasks.tickFromAgenda(agenda, form, { done: true, access: refusing })).toEqual({ ok: false, problem: "unknown-agenda" });
    const unknown = "3f0b2a52-0000-4000-8000-000000000000" as ItemId;
    expect(await instance.app.tasks.tickFromAgenda(agenda, unknown, { done: true, access: openAgendaAccess })).toEqual({ ok: false, problem: "unknown-task" });
    expect((await shown()).pinned).toEqual(["Sign the trip form (due)"]);
  });

  it("strikes a done Task through when it is cancelled", async () => {
    await arrive({ ...sportsKit, cancelled: true });
    await instance.app.tasks.tickFromAgenda(agenda, await taskId("Bring sports kit"), { done: true, access: openAgendaAccess });

    expect(await shown()).toEqual({ pinned: [], days: { "2026-09-16": ["Bring sports kit (done, cancelled)"] } });
  });

  it("keeps a cancelled Task that is not done pinned and struck through, with or without a Deadline, until it is ticked", async () => {
    await arrive({ ...sportsKit, cancelled: true }, task("form", "2026-09-10T10:00:00Z", { title: "Sign the trip form", cancelled: true }));
    instance.clock.advance(2 * days);

    expect(await shown()).toEqual({ pinned: ["Bring sports kit (due, cancelled)", "Sign the trip form (due, cancelled)"], days: {} });
    await instance.app.tasks.tickFromAgenda(agenda, await taskId("Sign the trip form"), { done: true, access: openAgendaAccess });
    expect(await shown()).toEqual({ pinned: ["Bring sports kit (due, cancelled)"], days: {} });
  });

  /** The feed's VEVENTs as their main properties, parsed as a calendar app would. */
  const feed = async () => {
    const found = await instance.app.agendas.feed(agenda, { access: openAgendaAccess });
    const calendar = new ICAL.Component(ICAL.parse(icsFeed(found!, `http://agenda.local/agendas/${agenda}`)) as unknown[]);
    return calendar.getAllSubcomponents("vevent").map((vevent) => ({
      uid: vevent.getFirstPropertyValue("uid"),
      summary: vevent.getFirstPropertyValue("summary"),
      start: (vevent.getFirstPropertyValue("dtstart") as ICAL.Time).toString(),
      end: (vevent.getFirstPropertyValue("dtend") as ICAL.Time).toString(),
      status: vevent.getFirstPropertyValue("status"),
      description: vevent.getFirstPropertyValue("description"),
    }));
  };

  it("carries undone Tasks with a Deadline in the feed as all-day entries, until they are ticked done", async () => {
    await arrive(
      sportsKit,
      task("form", "2026-09-10T10:00:00Z", { title: "Sign the trip form" }),
      task("library", "2026-09-10T10:00:00Z", { title: "Return library books", deadline: "2026-09-12" }),
      task("old", "2026-07-01T10:00:00Z", { title: "Pay for the photos", deadline: "2026-07-01" }),
    );

    expect(await feed()).toEqual([
      {
        uid: `${await taskId("Return library books")}@family-agenda`,
        summary: "Return library books",
        start: "2026-09-12",
        end: "2026-09-13",
        status: null,
        description: `Overdue · by Sat 12 Sept\n\nhttp://agenda.local/agendas/${agenda}`,
      },
      {
        uid: `${await taskId("Bring sports kit")}@family-agenda`,
        summary: "Bring sports kit",
        start: "2026-09-16",
        end: "2026-09-17",
        status: null,
        description: `By Wed 16 Sept\nBring: Trainers, Towel\n\nhttp://agenda.local/agendas/${agenda}`,
      },
    ]);

    const kit = await taskId("Bring sports kit");
    await instance.app.tasks.tickFromAgenda(agenda, kit, { done: true, access: openAgendaAccess });
    expect((await feed()).map((entry) => entry.summary)).toEqual(["Return library books"]);

    await instance.app.tasks.tickFromAgenda(agenda, kit, { done: false, access: openAgendaAccess });
    await instance.query(`UPDATE task SET cancelled = true WHERE item_id = '${kit}'`);
    expect((await feed()).map(({ summary, status }) => ({ summary, status }))).toEqual([
      { summary: "Return library books", status: null },
      { summary: "Bring sports kit", status: "CANCELLED" },
    ]);
  });

  it("refuses a Source stating a Task, which only a message can", async () => {
    testPluginControls.emit("school", [
      { externalId: "form", attributes: ["main"], content: { kind: "stated", stated: { kind: "task", title: "Sign the trip form" } as never } },
    ]);
    instance.clock.advance(15 * minutes);

    expect((await instance.app.polling.pollDue()).failed).toMatchObject([{ kind: "definite" }]);
    expect(await shown()).toEqual({ pinned: [], days: {} });
  });
});

/** A school mail as a mailbox Source emits it, sent at `sentAt`. */
const mail = (id: string, sentAt: string, text: string, thread = id): Origin => ({
  externalId: id,
  occurredAt: new Date(sentAt),
  sender: "klasse5b@schule.example.org", attributes: ["main"],
  content: { kind: "raw-message", text, attachments: [], thread },
});

const packingList =
  "Liebe Eltern,\n\nfür den Ausflug am Freitag, 18.09., bitte mitgeben: Regenjacke, Brotdose und Trinkflasche.\n\nViele Grüße";

const tripPacking = extractedTask({
  title: "Sachen für den Ausflug",
  deadline: { day: 18, month: 9, weekday: "friday" },
  bring: ["Regenjacke", "Brotdose", "Trinkflasche"],
  evidence: "für den Ausflug am Freitag, 18.09., bitte mitgeben: Regenjacke, Brotdose und Trinkflasche",
});

describe("Tasks extracted from mail", () => {
  let instance: TestInstance;
  let extractor: ScriptedExtractor;
  let agenda: AgendaId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    extractor = new ScriptedExtractor();
    instance = await bootForTest({ extractor, blobStore: new InMemoryBlobStore() });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "mailbox", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    const added = await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    const saved = await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    if (!saved.ok) throw new Error(`saving failed: ${saved.problem}`);
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    agenda = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  const arrive = async (...origins: Origin[]) => {
    testPluginControls.emit("mailbox", origins);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
    return instance.app.extraction.extractPending();
  };

  /** Every Task the Agenda shows, pinned or on a day, with its Deadline and things to bring. */
  const tasks = async () => {
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    return [...(page?.pinned ?? []), ...(page?.days ?? []).flatMap((day) => day.tasks)].map(
      ({ title, deadline, bring, status, cancelled, messages }) => ({ title, deadline, bring, status, cancelled, messages: messages.length }),
    );
  };

  it("turns a packing list into one Task with its things to bring", async () => {
    extractor.script("Ausflug", [], [tripPacking]);

    await arrive(mail("m1", "2026-09-14T06:12:00Z", packingList));

    expect(await tasks()).toEqual([
      {
        title: "Sachen für den Ausflug",
        deadline: "2026-09-18",
        bring: ["Regenjacke", "Brotdose", "Trinkflasche"],
        status: "upcoming",
        cancelled: false,
        messages: 1,
      },
    ]);
  });

  it("turns something to do without a date into a Task pinned at once", async () => {
    extractor.script("Formular", [], [
      extractedTask({ title: "Formular unterschreiben", evidence: "bitte das Formular unterschrieben zurückgeben" }),
    ]);

    await arrive(mail("m1", "2026-09-14T06:12:00Z", "Liebe Eltern, bitte das Formular unterschrieben zurückgeben."));

    expect(await tasks()).toMatchObject([{ title: "Formular unterschreiben", deadline: null, status: "due" }]);
  });

  it("takes a month alone for a Deadline on its last day", async () => {
    extractor.script("Umfrage", [], [
      extractedTask({
        title: "Umfrage der Stadt ausfüllen",
        deadline: { month: 9, year: 2026 },
        evidence: "Eine Teilnahme ist bis Ende September 2026 möglich.",
      }),
    ]);

    await arrive(mail("m1", "2026-09-14T06:12:00Z", "Die Umfrage der Stadt läuft. Eine Teilnahme ist bis Ende September 2026 möglich."));
    instance.clock.advance(10 * days);

    expect(await tasks()).toMatchObject([{ title: "Umfrage der Stadt ausfüllen", deadline: "2026-09-30", status: "upcoming" }]);
  });

  it("rejects a Task whose evidence quote the mail does not contain, or whose weekday does not match its Deadline", async () => {
    extractor.script("Ausflug", [], [
      { ...tripPacking, evidence: "bitte Regenjacke mitgeben" },
      { ...tripPacking, title: "Wrong day", deadline: { ...tripPacking.deadline, weekday: "thursday" } },
    ]);

    const report = await arrive(mail("m1", "2026-09-14T06:12:00Z", packingList));

    expect(await tasks()).toEqual([]);
    expect(report.dropped.map(({ problem }) => problem)).toEqual(["evidence-not-found", "weekday-mismatch"]);
  });

  it("does not write a Task whose fields a Task cannot have", async () => {
    extractor.script("Ausflug", [], [{ ...tripPacking, bring: ["Regenjacke", ""] }]);

    const report = await arrive(mail("m1", "2026-09-14T06:12:00Z", packingList));

    expect(await tasks()).toEqual([]);
    expect(report.dropped).toEqual([expect.objectContaining({ problem: "invalid-fields" })]);
  });
});
