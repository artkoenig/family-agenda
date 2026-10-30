import type { Origin } from "@family-agenda/source-sdk";
import { openViewAccess } from "@family-agenda/application";
import type { SourceId, ViewId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, extractedTask, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

/** A school mail as a mailbox Source emits it, sent at `sentAt`. */
const mail = (id: string, sentAt: string, text: string, thread = id): Origin => ({
  externalId: id,
  occurredAt: new Date(sentAt),
  attributes: { sender: "schulleitung@schule.example.org" },
  content: { kind: "raw-message", text, attachments: [], thread },
});

const autumn =
  "Liebe Familien,\n\nder 2.10.2026 ist ein Studientag. Am Mittwoch, dem 7. Oktober, kontrolliert die Polizei die Fahrräder.\n\nViele Grüße";

const studyDay = extracted({
  title: "Studientag",
  date: { day: 2, month: 10, year: 2026 },
  evidence: "der 2.10.2026 ist ein Studientag",
});

const bikeCheck = extracted({
  title: "Fahrradkontrolle",
  date: { day: 7, month: 10, weekday: "wednesday" },
  evidence: "Am Mittwoch, dem 7. Oktober, kontrolliert die Polizei die Fahrräder",
});

describe("Re-reading messages", () => {
  let instance: TestInstance;
  let extractor: ScriptedExtractor;
  let blobs: InMemoryBlobStore;
  let view: ViewId;
  let mailbox: SourceId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    extractor = new ScriptedExtractor();
    blobs = new InMemoryBlobStore();
    instance = await bootForTest({ extractor, blobStore: blobs });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "mailbox", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    const added = await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    mailbox = added.id;
    const saved = await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    if (!saved.ok) throw new Error(`saving failed: ${saved.problem}`);
    const created = await instance.app.views.create({ preselected: [], horizonDays: 31 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    view = created.id;
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

  const events = async () => {
    const page = await openTimeline(instance.app, view, { access: openViewAccess });
    return (page?.days ?? []).flatMap((day) => day.items.map((row) => ({ date: day.date, title: row.title, itemId: row.itemId })));
  };

  const tasks = async () => {
    const page = await openTimeline(instance.app, view, { access: openViewAccess });
    return [...(page?.pinned ?? []), ...(page?.days ?? []).flatMap((day) => day.tasks)];
  };

  const rejections = async () =>
    (await instance.query("SELECT rejection, count(*)::int AS count FROM revisions GROUP BY rejection ORDER BY rejection")).map(
      (row) => [row.rejection, row.count],
    );

  it("re-reads a message with the current prompt, keeping the Items it states again", async () => {
    extractor.script("Studientag", [studyDay]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", autumn));
    const [before] = await events();
    extractor.script("Studientag", [studyDay, bikeCheck]);

    expect(await instance.app.extraction.reread()).toBe(1);
    expect(await instance.app.extraction.waiting()).toBe(1);
    await instance.app.extraction.extractPending();

    expect(await events()).toMatchObject([
      { date: "2026-10-02", title: "Studientag", itemId: before!.itemId },
      { date: "2026-10-07", title: "Fahrradkontrolle" },
    ]);
    expect(await instance.app.extraction.waiting()).toBe(0);
  });

  it("keeps the old result visible until the message is re-read", async () => {
    extractor.script("Studientag", [studyDay]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", autumn));

    await instance.app.extraction.reread();

    expect(await events()).toMatchObject([{ title: "Studientag" }]);
  });

  it("removes an Item the message no longer states, superseding its Revisions without deleting them", async () => {
    extractor.script("Studientag", [studyDay, bikeCheck]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", autumn));
    extractor.script("Studientag", [studyDay]);

    await instance.app.extraction.reread();
    await instance.app.extraction.extractPending();

    expect((await events()).map((row) => row.title)).toEqual(["Studientag"]);
    expect(await rejections()).toEqual([
      ["superseded", 1],
      [null, 1],
    ]);
  });

  it("brings an Item whose Revision was rejected before, when a better reading finds it", async () => {
    extractor.script("Studientag", [{ ...studyDay, evidence: "Studientag am 2. November" }]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", autumn));
    expect(await events()).toEqual([]);
    extractor.script("Studientag", [studyDay]);

    await instance.app.extraction.reread();
    await instance.app.extraction.extractPending();

    expect((await events()).map((row) => row.title)).toEqual(["Studientag"]);
    // It states the same Revision, which comes back accepted now that its evidence is found.
    expect(await rejections()).toEqual([[null, 1]]);
  });

  it("keeps a ticked Task ticked when the message states it again", async () => {
    const survey = extractedTask({ title: "Umfrage ausfüllen", evidence: "der 2.10.2026 ist ein Studientag" });
    extractor.script("Studientag", [], [survey]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", autumn));
    const [task] = await tasks();
    await instance.app.tasks.tickFromView(view, task!.itemId, { done: true, access: openViewAccess });

    await instance.app.extraction.reread();
    await instance.app.extraction.extractPending();

    expect(await instance.app.tasks.ticks(task!.itemId)).toHaveLength(1);
    expect(await tasks()).toMatchObject([{ itemId: task!.itemId, status: "done" }]);
  });

  it("shows a re-read message only what earlier messages of its thread stated", async () => {
    const invitation = "Elternabend am Donnerstag, 17.09., um 19:30 Uhr.";
    extractor.script("Elternabend am", [
      extracted({ title: "Elternabend", date: { day: 17, month: 9, weekday: "thursday" }, startTime: "19:30", evidence: invitation.slice(0, -1) }),
    ]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", invitation));
    extractor.script("verlegt", [extracted({ updates: "E1", startTime: "16:00", evidence: "auf 16 Uhr verlegt" })]);
    await arrive(mail("m2", "2026-09-15T10:00:00Z", "Der Elternabend wird auf 16 Uhr verlegt.", "m1"));
    extractor.requests.length = 0;

    await instance.app.extraction.reread();
    await instance.app.extraction.extractPending();

    expect(extractor.requests.map((request) => request.knownEvents.map((event) => event.when))).toEqual([
      [],
      ["2026-09-17 19:30–19:30"],
    ]);
    expect(await events()).toMatchObject([{ title: "Elternabend" }]);
    const page = await openTimeline(instance.app, view, { access: openViewAccess });
    expect(page?.days.flatMap((day) => day.items)[0]).toMatchObject({ from: "16:00" });
  });

  it("keeps what a message stated when its text is gone", async () => {
    extractor.script("Studientag", [studyDay]);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", autumn));
    const [message] = await instance.query("SELECT text_blob FROM raw_messages");
    await blobs.remove(message!.text_blob as never);

    await instance.app.extraction.reread();
    await instance.app.extraction.extractPending();

    expect((await events()).map((row) => row.title)).toEqual(["Studientag"]);
    expect(await instance.app.extraction.waiting()).toBe(0);
  });

  it("re-reads only the messages of the Source asked for, and none of a withdrawn Origin", async () => {
    const other = await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.other.example.org" }, secrets: {} });
    if (!other.ok) throw new Error(`adding failed: ${other.problem}`);
    await arrive(mail("m1", "2026-09-14T06:12:00Z", autumn), mail("m2", "2026-09-14T06:13:00Z", "Mensa"));
    await instance.query("UPDATE origins SET withdrawn_at = now() WHERE external_id = 'm2'");

    expect(await instance.app.extraction.reread({ sourceId: other.id })).toBe(0);
    expect(await instance.app.extraction.reread({ sourceId: mailbox })).toBe(1);
    expect(await instance.app.extraction.waiting({ sourceId: mailbox })).toBe(1);
    expect(await instance.app.extraction.waiting({ sourceId: other.id })).toBe(0);
  });

});
