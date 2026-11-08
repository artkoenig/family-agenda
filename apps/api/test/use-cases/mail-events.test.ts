import type { Origin } from "@family-agenda/source-sdk";
import { extractionBackoffMs, openAgendaAccess } from "@family-agenda/application";
import type { AgendaId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

/** A school mail as a mailbox Source emits it, sent at `sentAt`. */
const mail = (id: string, sentAt: string, text: string): Origin => ({
  externalId: id,
  occurredAt: new Date(sentAt),
  sender: "klasse5b@schule.example.org", attributes: ["main"],
  content: { kind: "raw-message", text, attachments: [] },
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
    await writeTestPluginPackage(instance.publishedPlugins, { sourceTypeId: "mailbox", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    const added = await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    const saved = await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    if (!saved.ok) throw new Error(`saving failed: ${saved.problem}`);
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 7 });
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
    expect(message).toMatchObject({ text: invitation, sender: "klasse5b@schule.example.org", attributes: ["main"] });
  });

  it("does not write an Event whose evidence quote the mail does not contain, after reading the mail once more", async () => {
    extractor.script("Elternabend", [{ ...parentsEvening, evidence: "Elternabend am Donnerstag um 19:30 Uhr" }]);

    const report = await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));

    expect(await timeline()).toEqual({});
    expect(extractor.requests).toHaveLength(2);
    expect(report.dropped).toEqual([expect.objectContaining({ title: "Elternabend Klasse 5b", problem: "evidence-not-found" })]);
  });

  it("does not write an Event stated at a time that is no time of day", async () => {
    extractor.script("Elternabend", [{ ...parentsEvening, startTime: "25:00" }]);

    const report = await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));

    expect(await timeline()).toEqual({});
    expect(report.dropped).toEqual([expect.objectContaining({ problem: "invalid-fields" })]);
  });

  it("writes what a second reading states when an Item of the first failed a check", async () => {
    const wrongWeekday = { ...parentsEvening, date: { ...parentsEvening.date, weekday: "wednesday" as const } };
    extractor.scriptReadings("Elternabend", [{ events: [wrongWeekday] }, { events: [parentsEvening] }]);

    const report = await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));

    expect(await timeline()).toEqual({ "2026-09-17": ["19:30-19:30 Elternabend Klasse 5b"] });
    expect(extractor.requests).toHaveLength(2);
    expect(report.dropped).toEqual([]);
  });

  it("writes the Items that pass even when another one fails both readings", async () => {
    const noDate = extracted({ title: "Lesenacht", evidence: "Elternabend der Klasse 5b" });
    extractor.script("Elternabend", [parentsEvening, noDate]);

    const report = await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));

    expect(await timeline()).toEqual({ "2026-09-17": ["19:30-19:30 Elternabend Klasse 5b"] });
    expect(report.dropped).toEqual([expect.objectContaining({ title: "Lesenacht", problem: "no-date" })]);
  });

  it("reads a mail only once, so that an edit of it changes nothing", async () => {
    extractor.script("Elternabend", [parentsEvening]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));
    extractor.script("Elternabend", [{ ...parentsEvening, startTime: "18:00" }]);

    await arrive(mail("m1", "2026-09-14T06:12:00Z", `${invitation}\n\nNachtrag: schon um 18 Uhr.`));

    expect(await timeline()).toEqual({ "2026-09-17": ["19:30-19:30 Elternabend Klasse 5b"] });
    expect(extractor.requests).toHaveLength(1);
  });

  it("lets an Admin delete a wrong Item next to its message, and does not bring it back", async () => {
    extractor.script("Elternabend", [parentsEvening]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    const messageId = page!.days[3]!.items[0]!.messages[0]!.id;
    const [item] = (await instance.app.messages.open(messageId))!.items;
    expect(item).toMatchObject({ kind: "event", event: { title: "Elternabend Klasse 5b" } });

    expect(await instance.app.messages.deleteItem(item!.id)).toBe(true);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));

    expect(await timeline()).toEqual({});
    expect((await instance.app.messages.open(messageId))!.items).toEqual([]);
    expect(await instance.app.messages.deleteItem(item!.id)).toBe(false);
  });

  it("rejects an Event whose weekday does not match its date", async () => {
    extractor.script("Elternabend", [{ ...parentsEvening, date: { ...parentsEvening.date, weekday: "wednesday" } }]);

    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));

    expect(await timeline()).toEqual({});
  });

  it("adds nothing for a mail that only informs", async () => {
    const newsletter = "Liebe Eltern,\n\ndie Mensa bietet ab sofort auch vegetarische Gerichte an.";

    const report = await arrive(mail("m1", "2026-09-14T06:12:00Z", newsletter));

    expect(report.extracted).toHaveLength(1);
    expect(await timeline()).toEqual({});
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
      await writeTestPluginPackage(fresh.publishedPlugins, { sourceTypeId: "inbox", needsLlm: true });
      await fresh.restart();
      await fresh.app.sourceTypes.enable("inbox");
      await fresh.app.sources.add({ sourceTypeId: "inbox", plain: { url: "imap.example.org" }, secrets: {} });
      testPluginControls.emit("inbox", [mail("m1", "2026-09-14T06:12:00Z", invitation)]);
      await fresh.app.polling.pollDue();

      expect(await fresh.app.extraction.extractPending()).toEqual({ extracted: [], dropped: [], failed: [] });

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
    instance.clock.advance(extractionBackoffMs);
    await instance.app.extraction.extractPending();
    expect(await timeline()).toEqual({ "2026-09-17": ["19:30-19:30 Elternabend Klasse 5b"] });
  });

  it("does not send a mail whose text is gone to the endpoint", async () => {
    const blobs = new InMemoryBlobStore();
    const fresh = await bootForTest({ extractor, blobStore: blobs });
    try {
      await writeTestPluginPackage(fresh.publishedPlugins, { sourceTypeId: "inbox", needsLlm: true });
      await fresh.restart();
      await fresh.app.sourceTypes.enable("inbox");
      await fresh.app.sources.add({ sourceTypeId: "inbox", plain: { url: "imap.example.org" }, secrets: {} });
      await fresh.app.llmEndpoint.save({ baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b", apiKey: "" });
      testPluginControls.emit("inbox", [mail("m1", "2026-09-14T06:12:00Z", invitation)]);
      await fresh.app.polling.pollDue();
      await fresh.query("UPDATE source_record SET sender = NULL, subject = NULL, body = NULL, purged_at = now()");
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
      await writeTestPluginPackage(fresh.publishedPlugins, { sourceTypeId: "inbox", needsLlm: true });
      await fresh.restart();
      await fresh.app.sourceTypes.enable("inbox");
      await fresh.app.sources.add({ sourceTypeId: "inbox", plain: { url: "imap.example.org" }, secrets: {} });
      const withAttachment: Origin = {
        ...mail("m1", "2026-09-14T06:12:00Z", invitation),
        content: {
          kind: "raw-message",
          text: invitation,
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
