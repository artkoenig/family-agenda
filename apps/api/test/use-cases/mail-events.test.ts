import type { Origin } from "@family-agenda/source-sdk";
import { openAgendaAccess } from "@family-agenda/application";
import type { AgendaId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

/** A school mail as a mailbox Source emits it, sent at `sentAt`. */
const mail = (id: string, sentAt: string, text: string, thread = id): Origin => ({
  externalId: id,
  occurredAt: new Date(sentAt),
  attributes: { sender: "klasse5b@schule.example.org" },
  content: { kind: "raw-message", text, attachments: [], thread },
});

const invitation =
  "Liebe Eltern,\n\nder Elternabend der Klasse 5b findet am Donnerstag, 17.09., um 19:30 Uhr in Raum 104 statt.\n\nViele Grüße";

const parentsEvening = extracted({
  title: "Elternabend Klasse 5b",
  date: { day: 17, month: 9, weekday: "thursday" },
  startTime: "19:30",
  place: "Raum 104",
  evidence: "Elternabend der Klasse 5b findet am Donnerstag, 17.09., um 19:30 Uhr",
});

describe("Events extracted from mail", () => {
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

  /** The mailbox emits the mails on its next run, and the worker runs it and extracts them. */
  const arrive = async (...origins: Origin[]) => {
    testPluginControls.emit("mailbox", origins);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
    return instance.app.extraction.extractPending();
  };

  const timeline = async () => {
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    return Object.fromEntries(
      (page?.days ?? [])
        .filter((day) => day.items.length > 0)
        .map((day) => [day.date, day.items.map((row) => `${row.from ?? ""}-${row.until ?? ""} ${row.title}${row.cancelled ? " (cancelled)" : ""}`)]),
    );
  };

  it("turns a mail into an Event on the timeline, with the mail in its details", async () => {
    extractor.script("Elternabend", [parentsEvening]);

    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));

    expect(await timeline()).toEqual({ "2026-09-17": ["19:30-19:30 Elternabend Klasse 5b"] });
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    const row = page?.days[3]?.items[0];
    expect(row).toMatchObject({ place: "Raum 104", links: [] });
    expect(row?.messages.map((message) => message.source)).toEqual(["mailbox"]);
    const message = await instance.app.messages.open(row!.messages[0]!.id);
    expect(message).toMatchObject({ text: invitation, attributes: { sender: "klasse5b@schule.example.org" } });
  });

  it("rejects an Event whose evidence quote the mail does not contain", async () => {
    extractor.script("Elternabend", [{ ...parentsEvening, evidence: "Elternabend am Donnerstag um 19:30 Uhr" }]);

    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));

    expect(await timeline()).toEqual({});
  });

  it("rejects an Event whose weekday does not match its date", async () => {
    extractor.script("Elternabend", [{ ...parentsEvening, date: { ...parentsEvening.date, weekday: "wednesday" } }]);

    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));

    expect(await timeline()).toEqual({});
  });

  it("does not link an Event to a later mail of its thread whose Revision was rejected", async () => {
    extractor.script("Elternabend der Klasse", [parentsEvening]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));
    extractor.script("verlegt", [extracted({ updates: "E1", startTime: "16:00", evidence: "auf 16 Uhr verschoben" })]);

    await arrive(mail("m2", "2026-09-15T10:00:00Z", "Der Elternabend wird auf 16 Uhr verlegt.", "m1"));

    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    expect(page?.days[3]?.items[0]).toMatchObject({ from: "19:30" });
    expect(page?.days[3]?.items[0]?.messages).toHaveLength(1);
  });

  it("adds nothing for a mail that only informs", async () => {
    const newsletter = "Liebe Eltern,\n\ndie Mensa bietet ab sofort auch vegetarische Gerichte an.";

    const report = await arrive(mail("m1", "2026-09-14T06:12:00Z", newsletter));

    expect(report.extracted).toHaveLength(1);
    expect(await timeline()).toEqual({});
  });

  it("updates the Event when a later mail of the same thread moves it", async () => {
    extractor.script("Elternabend der Klasse", [parentsEvening]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));
    const moved = "Liebe Eltern,\n\nder Elternabend wird auf 16 Uhr verlegt.";
    extractor.script("verlegt", [
      extracted({ updates: "E1", startTime: "16:00", evidence: "der Elternabend wird auf 16 Uhr verlegt" }),
    ]);

    await arrive(mail("m2", "2026-09-15T10:00:00Z", moved, "m1"));

    expect(await timeline()).toEqual({ "2026-09-17": ["16:00-16:00 Elternabend Klasse 5b"] });
    expect(extractor.requests.at(-1)?.knownEvents).toEqual([
      { ref: "E1", title: "Elternabend Klasse 5b", when: "2026-09-17 19:30–19:30", place: "Raum 104" },
    ]);
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    expect(page?.days[3]?.items[0]?.messages).toHaveLength(2);
  });

  it("ends an Event at the stated end time, and keeps its duration when a later mail moves only the start", async () => {
    extractor.script("Elternabend der Klasse", [{ ...parentsEvening, endTime: "20:30" }]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));
    extractor.script("früher", [extracted({ updates: "E1", startTime: "18:00", evidence: "beginnt eine Stunde früher" })]);
    expect(await timeline()).toEqual({ "2026-09-17": ["19:30-20:30 Elternabend Klasse 5b"] });

    await arrive(mail("m2", "2026-09-15T10:00:00Z", "Der Elternabend beginnt eine Stunde früher.", "m1"));

    expect(await timeline()).toEqual({ "2026-09-17": ["18:00-19:00 Elternabend Klasse 5b"] });
  });

  it("ends an Event stated to end before it starts on the next day", async () => {
    const sleepover = "Die Übernachtung der Klasse 5b ist am Freitag, 18.09., von 20 Uhr bis 8 Uhr.";
    extractor.script("Übernachtung", [
      extracted({ title: "Übernachtung", date: { day: 18, month: 9 }, startTime: "20:00", endTime: "08:00", evidence: "am Freitag, 18.09., von 20 Uhr bis 8 Uhr" }),
    ]);

    await arrive(mail("m1", "2026-09-14T06:12:00Z", sleepover));

    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    expect(page?.days[4]?.items[0]).toMatchObject({ title: "Übernachtung", from: "20:00" });
  });

  it("changes the title and place of an Event without moving it", async () => {
    extractor.script("Elternabend der Klasse", [parentsEvening]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));
    extractor.script("Aula", [extracted({ updates: "E1", title: "Elternabend Jahrgang 5", place: "Aula", evidence: "findet in der Aula statt" })]);

    await arrive(mail("m2", "2026-09-15T10:00:00Z", "Der Elternabend findet in der Aula statt.", "m1"));

    expect(await timeline()).toEqual({ "2026-09-17": ["19:30-19:30 Elternabend Jahrgang 5"] });
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    expect(page?.days[3]?.items[0]).toMatchObject({ place: "Aula" });
  });

  it("moves an all-day Event to another day, and to a time of day", async () => {
    extractor.script("Wandertag", [extracted({ title: "Wandertag", date: { day: 16, month: 9 }, evidence: "Wandertag am 16.09." })]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", "Der Wandertag am 16.09. findet statt."));
    extractor.script("verschoben", [extracted({ updates: "E1", date: { day: 17, month: 9 }, evidence: "auf den 17.09. verschoben" })]);
    expect(Object.keys(await timeline())).toEqual(["2026-09-16"]);

    await arrive(mail("m2", "2026-09-15T10:00:00Z", "Der Wandertag wird auf den 17.09. verschoben.", "m1"));
    expect(Object.keys(await timeline())).toEqual(["2026-09-17"]);

    extractor.script("Treffpunkt", [extracted({ updates: "E1", startTime: "08:00", evidence: "Treffpunkt ist um 8 Uhr" })]);
    await arrive(mail("m3", "2026-09-15T11:00:00Z", "Treffpunkt ist um 8 Uhr.", "m1"));
    expect(await timeline()).toEqual({ "2026-09-17": ["08:00-08:00 Wandertag"] });
  });

  it("cancels the Event when a later mail of the thread calls it off", async () => {
    extractor.script("Elternabend der Klasse", [parentsEvening]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));
    extractor.script("fällt aus", [extracted({ updates: "E1", cancelled: true, evidence: "Der Elternabend fällt aus" })]);

    await arrive(mail("m2", "2026-09-15T10:00:00Z", "Der Elternabend fällt aus.", "m1"));

    expect(await timeline()).toEqual({ "2026-09-17": ["19:30-19:30 Elternabend Klasse 5b (cancelled)"] });
  });

  it("resolves relative dates against the time the mail was sent, not when it is read", async () => {
    const reminder = "Morgen ist Wandertag, Treffpunkt 8 Uhr am Bahnhof.";
    extractor.script("Wandertag", [
      extracted({ title: "Wandertag", date: { daysAfter: 1 }, startTime: "08:00", place: "Bahnhof", evidence: "Morgen ist Wandertag, Treffpunkt 8 Uhr" }),
    ]);

    // Sent on Sunday evening, read on Monday.
    await arrive(mail("m1", "2026-09-13T18:00:00Z", reminder));

    expect(await timeline()).toEqual({ "2026-09-14": ["08:00-08:00 Wandertag"] });
    expect(extractor.requests.at(-1)?.message.sent).toEqual({ date: "2026-09-13", time: "20:00", weekday: "sunday" });
  });

  it("lets mails wait while no LLM endpoint is configured, and extracts each only once", async () => {
    const fresh = await bootForTest({ extractor, blobStore: new InMemoryBlobStore() });
    try {
      await writeTestPluginPackage(fresh.workspacePackages, { sourceTypeId: "inbox", needsLlm: true });
      await fresh.restart();
      await fresh.app.sourceTypes.enable("inbox");
      await fresh.app.sources.add({ sourceTypeId: "inbox", plain: { url: "imap.example.org" }, secrets: {} });
      testPluginControls.emit("inbox", [mail("m1", "2026-09-14T06:12:00Z", invitation)]);
      await fresh.app.polling.pollDue();

      expect(await fresh.app.extraction.extractPending()).toEqual({ extracted: [], failed: [] });

      await fresh.app.llmEndpoint.save({ baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b", apiKey: "" });
      expect((await fresh.app.extraction.extractPending()).extracted).toHaveLength(1);
      expect((await fresh.app.extraction.extractPending()).extracted).toEqual([]);
    } finally {
      await fresh.close();
    }
  });

  it("keeps a mail waiting while the endpoint cannot be reached, and extracts it once it can", async () => {
    extractor.script("Elternabend", [parentsEvening]);
    extractor.fail("unreachable");

    const report = await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));
    expect(report.failed).toMatchObject([{ problem: "unreachable" }]);
    expect(await timeline()).toEqual({});

    extractor.recover();
    await instance.app.extraction.extractPending();
    expect(await timeline()).toEqual({ "2026-09-17": ["19:30-19:30 Elternabend Klasse 5b"] });
  });

  it("does not send a mail whose text is gone to the endpoint", async () => {
    const blobs = new InMemoryBlobStore();
    const fresh = await bootForTest({ extractor, blobStore: blobs });
    try {
      await writeTestPluginPackage(fresh.workspacePackages, { sourceTypeId: "inbox", needsLlm: true });
      await fresh.restart();
      await fresh.app.sourceTypes.enable("inbox");
      await fresh.app.sources.add({ sourceTypeId: "inbox", plain: { url: "imap.example.org" }, secrets: {} });
      await fresh.app.llmEndpoint.save({ baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b", apiKey: "" });
      testPluginControls.emit("inbox", [mail("m1", "2026-09-14T06:12:00Z", invitation)]);
      await fresh.app.polling.pollDue();
      await fresh.query("UPDATE source_record SET body = NULL");
      const before = extractor.requests.length;

      expect((await fresh.app.extraction.extractPending()).extracted).toHaveLength(0);
      expect(extractor.requests.length).toBe(before);
    } finally {
      await fresh.close();
    }
  });

  it("records a mail the mailbox emits again only once", async () => {
    const blobs = new InMemoryBlobStore();
    const fresh = await bootForTest({ extractor, blobStore: blobs });
    try {
      await writeTestPluginPackage(fresh.workspacePackages, { sourceTypeId: "inbox", needsLlm: true });
      await fresh.restart();
      await fresh.app.sourceTypes.enable("inbox");
      await fresh.app.sources.add({ sourceTypeId: "inbox", plain: { url: "imap.example.org" }, secrets: {} });
      const withAttachment: Origin = {
        ...mail("m1", "2026-09-14T06:12:00Z", invitation),
        content: {
          kind: "raw-message",
          text: invitation,
          thread: "m1",
          attachments: [{ filename: "brief.pdf", contentType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) }],
        },
      };

      testPluginControls.emit("inbox", [withAttachment]);
      await fresh.app.polling.pollDue();
      fresh.clock.advance(15 * minutes);
      testPluginControls.emit("inbox", [withAttachment]);
      await fresh.app.polling.pollDue();

      expect(blobs.size).toBe(1);
    } finally {
      await fresh.close();
    }
  });
});
