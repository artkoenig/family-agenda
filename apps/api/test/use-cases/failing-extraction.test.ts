import { maxExtractionFailures } from "@family-agenda/application";
import type { RawMessageId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import type { Origin } from "../support/test-source-plugin";
import { testPluginControls } from "../support/test-source-plugin";

const minutes = 60 * 1000;

/** A mail as a mailbox Source emits it, the `n`th to arrive. */
const mail = (id: string, n: number, text: string): Origin => ({
  externalId: id,
  occurredAt: new Date(Date.UTC(2026, 8, 14, 6, n)),
  sender: "klasse5b@schule.example.org",
  attributes: ["main"],
  content: { kind: "raw-message", text, attachments: [] },
});

const invitation = "Der Elternabend der Klasse 5b findet am Donnerstag, 17.09., um 19:30 Uhr statt.";
const parentsEvening = extracted({
  title: "Elternabend",
  date: { day: 17, month: 9, weekday: "thursday" },
  startTime: "19:30",
  evidence: "Elternabend der Klasse 5b findet am Donnerstag, 17.09., um 19:30 Uhr",
});

// The counterexamples of specs/extraction: a message failing every reading held up the messages
// after it, as nothing counted its failures (unboundedTimeout, unboundedInvalid); and two runs at
// once read a message twice (unchecked).
describe("messages whose extraction keeps failing", () => {
  let instance: TestInstance;
  let extractor: ScriptedExtractor;
  beforeEach(async () => {
    extractor = new ScriptedExtractor();
    instance = await bootForTest({ extractor, blobStore: new InMemoryBlobStore() });
    await instance.installPlugin({ sourceTypeId: "mailbox", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    const added = await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    const saved = await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    if (!saved.ok) throw new Error(`saving failed: ${saved.problem}`);
    extractor.script("Elternabend", [parentsEvening]);
  });
  afterEach(async () => {
    await instance.close();
  });

  const arrive = async (...origins: Origin[]) => {
    testPluginControls.emit("mailbox", origins);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
  };

  const extractedOf = async (externalId: string) =>
    instance.query(`SELECT processed_at IS NOT NULL AS processed, extraction_failures AS failures, extraction_failed_at IS NOT NULL AS failed
      FROM source_record WHERE external_id = '${externalId}'`);

  const idOf = async (externalId: string) =>
    ((await instance.query(`SELECT id FROM source_record WHERE external_id = '${externalId}'`)) as { id: RawMessageId }[])[0]!.id;

  /** The runs it takes the oldest message to fail: each ends at it. */
  const runsUntilItFails = async () => {
    for (let run = 1; run <= maxExtractionFailures; run++) await instance.app.extraction.extractPending();
  };

  it("fails a message whose reading times out every time, so that the messages after it are read", async () => {
    extractor.failFor("zu lang", "timeout");
    await arrive(mail("long", 0, "Ein Text, zu lang für das Modell."), mail("m2", 1, invitation));

    const first = await instance.app.extraction.extractPending();
    expect(first.failed).toMatchObject([{ problem: "timeout" }]);
    expect(first.extracted, "a timeout ends the run").toEqual([]);
    await runsUntilItFails();

    expect(await extractedOf("long")).toEqual([{ processed: false, failures: maxExtractionFailures, failed: true }]);
    expect(await extractedOf("m2")).toEqual([{ processed: true, failures: 0, failed: false }]);
  });

  it("fails messages answered with invalid output every time, so that they do not fill every batch", async () => {
    extractor.failFor("kaputt", "invalid-output");
    const broken = Array.from({ length: 20 }, (_, n) => mail(`broken${n}`, n, `Etwas kaputt ${n}`));
    await arrive(...broken, mail("m21", 30, invitation));

    for (let run = 1; run < maxExtractionFailures; run++) await instance.app.extraction.extractPending();
    expect(await extractedOf("m21"), "the 20 oldest fill each batch").toEqual([{ processed: false, failures: 0, failed: false }]);
    const last = await instance.app.extraction.extractPending();
    expect(last.gaveUp).toHaveLength(20);
    await instance.app.extraction.extractPending();

    expect(await extractedOf("m21")).toEqual([{ processed: true, failures: 0, failed: false }]);
    expect(await instance.app.extraction.waiting()).toBe(0);
  });

  it("does not count an unreachable endpoint or a refused key against a message", async () => {
    extractor.fail("unreachable");
    await arrive(mail("m1", 0, invitation));
    for (let run = 0; run < maxExtractionFailures + 1; run++) await instance.app.extraction.extractPending();
    extractor.recover();
    extractor.fail("unauthorized");
    await instance.app.extraction.extractPending();

    expect(await extractedOf("m1")).toEqual([{ processed: false, failures: 0, failed: false }]);
    extractor.recover();
    await instance.app.extraction.extractPending();
    expect(await extractedOf("m1")).toEqual([{ processed: true, failures: 0, failed: false }]);
  });

  it("reads a failed message again once an Admin retries it, and lists it until then", async () => {
    extractor.failFor("Elternabend", "invalid-output");
    await arrive(mail("m1", 0, invitation));
    await runsUntilItFails();
    const id = await idOf("m1");
    const [source] = await instance.app.sources.list();

    expect(await instance.app.messages.failed(source!.id)).toMatchObject([{ id }]);
    expect((await instance.app.messages.open(id))?.extractionFailedAt).toBeInstanceOf(Date);
    expect((await instance.app.extraction.extractPending()).failed, "no run reads it").toEqual([]);

    extractor.recover();
    extractor.script("Elternabend", [parentsEvening]);
    expect(await instance.app.messages.retryExtraction(id)).toBe(true);
    expect(await instance.app.messages.retryExtraction(id), "it no longer has failed").toBe(false);
    expect(await instance.app.extraction.extractPending()).toMatchObject({ extracted: [id] });
    expect(await instance.app.messages.failed(source!.id)).toEqual([]);
    expect(await instance.app.messages.retryExtraction("not-a-message" as RawMessageId)).toBe(false);
  });

  it("does not read a message again that another run read while this one was reading", async () => {
    await arrive(mail("m1", 0, invitation), mail("m2", 1, "Morgen ist schulfrei."));
    // A trigger's run reads both while the schedule's run waits for its first answer.
    extractor.meanwhile = async () => {
      await instance.app.extraction.extractPending();
    };

    const report = await instance.app.extraction.extractPending();

    expect(extractor.requests.map((request) => request.message.text.slice(0, 12)), "m1 twice at once, m2 once").toEqual([
      invitation.slice(0, 12),
      invitation.slice(0, 12),
      "Morgen ist s",
    ]);
    expect(report.extracted, "its recording of m1 is discarded, and it skips m2").toHaveLength(1);
    expect(await instance.query("SELECT count(*)::int AS n FROM item")).toEqual([{ n: 1 }]);
  });
});
