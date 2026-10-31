import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Origin } from "@family-agenda/source-sdk";
import { openAgendaAccess } from "@family-agenda/application";
import type { AgendaId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { fakePdf, FakeTextExtractor } from "../support/fake-text-extractor";
import { FakeTessdataCatalog } from "../support/fake-tessdata-catalog";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

type Attachment = { filename: string; contentType: string; bytes: Uint8Array };

/** A school mail with attachments, as a mailbox Source emits it. */
const mail = (id: string, text: string, attachments: Attachment[]): Origin => ({
  externalId: id,
  occurredAt: new Date("2026-09-14T06:12:00Z"),
  attributes: { sender: "klasse5b@schule.example.org" },
  content: { kind: "raw-message", text, attachments, thread: id },
});

const pdf = (filename: string, bytes: Uint8Array): Attachment => ({ filename, contentType: "application/pdf", bytes });

const covering = "Liebe Eltern,\n\nim Anhang finden Sie den Elternbrief zum Wandertag.\n\nViele Grüße";

const letter = "Elternbrief\n\nDer Wandertag der Klasse 5b findet am Freitag, 25.09., statt.\nTreffpunkt ist um 8:00 Uhr am Bahnhof.";

const hikingDay = extracted({
  title: "Wandertag",
  date: { day: 25, month: 9, weekday: "friday" },
  startTime: "08:00",
  place: "Bahnhof",
  evidence: "Der Wandertag der Klasse 5b findet am Freitag, 25.09., statt. Treffpunkt ist um 8:00 Uhr",
});

describe("Events extracted from PDF attachments", () => {
  let instance: TestInstance;
  let extractor: ScriptedExtractor;
  let textExtractor: FakeTextExtractor;
  let blobs: InMemoryBlobStore;
  let agenda: AgendaId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    extractor = new ScriptedExtractor();
    textExtractor = new FakeTextExtractor();
    blobs = new InMemoryBlobStore();
    instance = await bootForTest({ extractor, textExtractor, blobStore: blobs, tessdataCatalog: new FakeTessdataCatalog() });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "mailbox", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    const added = await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    await saveEndpoint({ vision: false });
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 14 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    agenda = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  const saveEndpoint = async ({ vision }: { vision: boolean }) => {
    const saved = await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "", vision });
    if (!saved.ok) throw new Error(`saving failed: ${saved.problem}`);
  };

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
        .map((day) => [day.date, day.items.map((row) => `${row.from ?? ""}-${row.until ?? ""} ${row.title}`)]),
    );
  };

  it("turns a letter in a PDF with a text layer into an Event, its quote found in the letter", async () => {
    extractor.script("Wandertag der Klasse 5b", [hikingDay]);

    await arrive(mail("m1", covering, [pdf("elternbrief.pdf", fakePdf({ text: letter }))]));

    expect(await timeline()).toEqual({ "2026-09-25": ["08:00-08:00 Wandertag"] });
    expect(extractor.requests[0]?.message.text).toContain(covering);
    expect(extractor.requests[0]?.message.text).toContain("Treffpunkt ist um 8:00 Uhr am Bahnhof.");
  });

  it("removes the mails, their attachments and their Events with their Source", async () => {
    extractor.script("Wandertag der Klasse 5b", [hikingDay]);
    await arrive(mail("m1", covering, [pdf("elternbrief.pdf", fakePdf({ text: letter }))]));
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    const message = page?.days.flatMap((day) => day.items)[0]?.messages[0]?.id;
    expect(message).toBeDefined();

    const [source] = await instance.app.sources.list();
    await instance.app.sources.remove(source!.id);

    expect(await timeline()).toEqual({});
    expect(await instance.app.messages.open(message!)).toBeNull();
    expect(blobs.size).toBe(0);
  });

  it("reads the scanned pages of a PDF with OCR when the endpoint cannot see images", async () => {
    extractor.script("Wandertag der Klasse 5b", [hikingDay]);
    const scanned = fakePdf({ text: "Elternbrief Seite 1: Allgemeine Hinweise zur Klassenfahrt." }, { scan: letter });

    await arrive(mail("m1", covering, [pdf("scan.pdf", scanned)]));

    expect(textExtractor.ocrPages).toEqual([[2]]);
    expect(textExtractor.ocrLanguages).toEqual([["eng"]]);
    expect(textExtractor.renderedPages).toEqual([]);
    expect(await timeline()).toEqual({ "2026-09-25": ["08:00-08:00 Wandertag"] });
    expect(extractor.requests[0]?.message.text).toContain("Allgemeine Hinweise zur Klassenfahrt.");
  });

  it("sends the scanned pages of a PDF to a vision-capable endpoint as images, and checks quotes against what it read", async () => {
    await saveEndpoint({ vision: true });
    extractor.script("Wandertag der Klasse 5b", [hikingDay]);
    const scanned = fakePdf({ text: "Elternbrief Seite 1: Allgemeine Hinweise zur Klassenfahrt." }, { scan: letter });

    await arrive(mail("m1", covering, [pdf("scan.pdf", scanned)]));

    expect(textExtractor.renderedPages).toEqual([[2]]);
    expect(textExtractor.ocrPages).toEqual([]);
    expect(extractor.transcriptions).toHaveLength(1);
    expect(extractor.transcriptions[0]?.images).toHaveLength(1);
    expect(await timeline()).toEqual({ "2026-09-25": ["08:00-08:00 Wandertag"] });
  });

  it("rejects an Event from an attachment whose quote the attachment does not contain", async () => {
    extractor.script("Wandertag der Klasse 5b", [{ ...hikingDay, evidence: "Wandertag am Freitag um 8 Uhr" }]);

    await arrive(mail("m1", covering, [pdf("elternbrief.pdf", fakePdf({ text: letter }))]));

    expect(await timeline()).toEqual({});
  });

  it("extracts a message whose attachment cannot be converted, and shows why on the message", async () => {
    extractor.script("Elternabend", [
      extracted({ title: "Elternabend", date: { day: 17, month: 9 }, startTime: "19:30", evidence: "Elternabend am 17.09. um 19:30 Uhr" }),
    ]);
    const text = "Liebe Eltern,\n\nder Elternabend am 17.09. um 19:30 Uhr. Die Einladung hängt an.";
    const broken = pdf("einladung.pdf", new TextEncoder().encode("no PDF at all"));
    const image = { filename: "foto.jpg", contentType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8]) };

    const report = await arrive(mail("m1", text, [broken, pdf("brief.pdf", fakePdf({ text: letter })), image]));

    expect(report).toMatchObject({ extracted: [expect.anything() as unknown], failed: [] });
    expect(await timeline()).toEqual({ "2026-09-17": ["19:30-19:30 Elternabend"] });
    expect(extractor.requests[0]?.message.text).toContain("Treffpunkt ist um 8:00 Uhr am Bahnhof.");
    const message = await instance.app.messages.open(report.extracted[0]!);
    expect(message?.attachments).toEqual([
      { position: 0, filename: "einladung.pdf", contentType: "application/pdf", size: 13, conversionProblem: "Syntax Error: Couldn't find trailer dictionary" },
      { position: 1, filename: "brief.pdf", contentType: "application/pdf", size: expect.any(Number) as unknown, conversionProblem: null },
      { position: 2, filename: "foto.jpg", contentType: "image/jpeg", size: 2, conversionProblem: null },
    ]);
  });

  it("leaves a message with a scan waiting while the vision-capable endpoint cannot be reached", async () => {
    await saveEndpoint({ vision: true });
    extractor.script("Wandertag der Klasse 5b", [hikingDay]);
    extractor.fail("unreachable");

    const failed = await arrive(mail("m1", covering, [pdf("scan.pdf", fakePdf({ scan: letter }))]));

    expect(failed).toMatchObject({ extracted: [], failed: [{ problem: "unreachable" }] });
    expect(extractor.requests).toEqual([]);

    extractor.recover();
    const report = await instance.app.extraction.extractPending();
    expect(report.extracted).toHaveLength(1);
    expect(await timeline()).toEqual({ "2026-09-25": ["08:00-08:00 Wandertag"] });
    const message = await instance.app.messages.open(report.extracted[0]!);
    expect(message?.attachments[0]?.conversionProblem).toBeNull();
  });

  it("does not read a PDF with more scanned pages than it reads at most", async () => {
    const pages = Array.from({ length: 11 }, () => ({ scan: letter }));

    const report = await arrive(mail("m1", covering, [pdf("scan.pdf", fakePdf(...pages))]));

    expect(textExtractor.ocrPages).toEqual([]);
    const message = await instance.app.messages.open(report.extracted[0]!);
    expect(message?.attachments[0]?.conversionProblem).toBe("It has 11 scanned pages; at most 10 are read.");
  });

  it("reads scanned pages with OCR in the Family's OCR languages, in their order", async () => {
    await instance.app.languages.setOcrLanguages(["deu", "eng"]);
    extractor.script("Wandertag der Klasse 5b", [hikingDay]);

    await arrive(mail("m1", covering, [pdf("scan.pdf", fakePdf({ scan: letter }))]));

    expect(textExtractor.ocrLanguages).toEqual([["deu", "eng"]]);
    expect(await timeline()).toEqual({ "2026-09-25": ["08:00-08:00 Wandertag"] });
  });

  it("does not read a scan when a chosen OCR language is not installed, and shows why on the message", async () => {
    await instance.app.languages.install("fra");
    await instance.app.languages.setOcrLanguages(["deu", "fra"]);
    await rm(join(instance.tessdataDirectory, "fra.traineddata"));

    const report = await arrive(
      mail("m1", covering, [pdf("scan.pdf", fakePdf({ scan: letter })), pdf("brief.pdf", fakePdf({ text: letter }))]),
    );

    expect(textExtractor.ocrPages).toEqual([]);
    const message = await instance.app.messages.open(report.extracted[0]!);
    expect(message?.attachments.map((attachment) => attachment.conversionProblem)).toEqual([
      "OCR language `fra` is not installed.",
      null,
    ]);
  });
});
