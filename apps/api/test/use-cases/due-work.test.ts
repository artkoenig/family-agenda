import type { Origin } from "@family-agenda/source-sdk";
import { createDueWork, extractionBackoffMs, maximumSleepMs } from "@family-agenda/application";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";

const minutes = 60 * 1000;
const seconds = 1000;

const mail = (id: string, text: string): Origin => ({
  externalId: id,
  occurredAt: new Date("2026-09-14T06:12:00Z"),
  sender: "klasse5b@schule.example.org",
  attributes: ["main"],
  content: { kind: "raw-message", text, attachments: [] },
});

describe("Due work", () => {
  let instance: TestInstance;
  let extractor: ScriptedExtractor;
  beforeEach(async () => {
    extractor = new ScriptedExtractor();
    instance = await bootForTest({ extractor });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "mailbox", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    const added = await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
  });
  afterEach(async () => {
    await instance.close();
  });

  const saveEndpoint = async () => {
    const saved = await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    if (!saved.ok) throw new Error(`saving failed: ${saved.problem}`);
  };
  const nextDueIn = async () => {
    const at = await instance.app.dueWork.nextDueAt();
    return at ? at.getTime() - instance.clock.now().getTime() : null;
  };
  const polls = () => testPluginControls.runs("mailbox").length;

  it("is due at once for a Source that never ran, and after its interval once it ran", async () => {
    expect(await nextDueIn()).toBe(0);

    await instance.app.dueWork.run();

    expect(await nextDueIn()).toBe(10 * minutes);
  });

  it("sleeps until work is due, but at most 15 seconds", async () => {
    expect(await instance.app.dueWork.sleepMs()).toBe(0);
    await instance.app.dueWork.run();
    expect(await instance.app.dueWork.sleepMs()).toBe(maximumSleepMs);

    instance.clock.advance(10 * minutes - 4 * seconds);
    expect(await instance.app.dueWork.sleepMs()).toBe(4 * seconds);
  });

  it("counts a last run in the future, such as after a clock change, as due", async () => {
    await instance.app.dueWork.run();
    instance.clock.advance(-60 * minutes);

    expect(await nextDueIn()).toBe(0);
    const before = polls();
    await instance.app.dueWork.run();
    expect(polls()).toBe(before + 1);
  });

  it("does not start a second round while one is running", async () => {
    let pollRuns = 0;
    let finish = () => {};
    const dueWork = createDueWork({
      clock: instance.clock,
      polling: {
        ...instance.app.polling,
        pollDue: () => {
          pollRuns += 1;
          return new Promise((resolve) => {
            finish = () => { resolve({ polled: [], failed: [], invalid: [], refused: [] }); };
          });
        },
      },
      extraction: instance.app.extraction,
    });

    const first = dueWork.run();
    const second = dueWork.run();
    finish();
    await Promise.all([first, second]);
    const third = dueWork.run();
    finish();
    await third;

    expect(pollRuns).toBe(2);
  });

  it("reports a step that throws and still runs the other", async () => {
    const dueWork = createDueWork({
      clock: instance.clock,
      polling: { ...instance.app.polling, pollDue: () => Promise.reject(new Error("boom")) },
      extraction: instance.app.extraction,
    });

    const report = await dueWork.run();

    expect(report.polling).toBeNull();
    expect(report.extraction).not.toBeNull();
    expect(report.errors.map((e) => e.step)).toEqual(["polling"]);
  });

  it("has no extraction due without an LLM endpoint", async () => {
    testPluginControls.emit("mailbox", [mail("m1", "Elternabend am Donnerstag")]);
    await instance.app.dueWork.run();

    expect(await instance.app.extraction.nextDueAt()).toBeNull();
  });

  it("waits the backoff before a Source's messages are read again after a failure", async () => {
    await saveEndpoint();
    extractor.fail("unreachable");
    testPluginControls.emit("mailbox", [mail("m1", "Elternabend am Donnerstag")]);

    const first = await instance.app.dueWork.run();
    expect(first.extraction?.failed).toHaveLength(1);
    const requests = extractor.requests.length;

    instance.clock.advance(extractionBackoffMs - seconds);
    expect((await instance.app.extraction.extractPending()).failed).toEqual([]);
    expect(extractor.requests).toHaveLength(requests);
    expect((await instance.app.extraction.nextDueAt())?.getTime()).toBe(instance.clock.now().getTime() + seconds);

    instance.clock.advance(seconds);
    expect((await instance.app.extraction.extractPending()).failed).toHaveLength(1);
    expect(extractor.requests).toHaveLength(requests + 1);
  });

  it("keeps the backoff when another message of the Source is extracted in the same round", async () => {
    await saveEndpoint();
    extractor.fail("invalid-output");
    extractor.script("Gut", []);
    testPluginControls.emit("mailbox", [mail("m1", "Elternabend am Donnerstag"), mail("m2", "Gut")]);

    await instance.app.dueWork.run();

    expect((await instance.query("SELECT last_extraction_failure_at FROM source_run"))[0]?.last_extraction_failure_at).not.toBeNull();
  });

  it("clears the backoff once a message is extracted", async () => {
    await saveEndpoint();
    extractor.fail("unreachable");
    testPluginControls.emit("mailbox", [mail("m1", "Elternabend am Donnerstag")]);
    await instance.app.dueWork.run();
    extractor.recover();
    instance.clock.advance(extractionBackoffMs);
    await instance.app.extraction.extractPending();

    expect((await instance.query("SELECT last_extraction_failure_at FROM source_run"))[0]?.last_extraction_failure_at).toBeNull();
    expect(await instance.app.extraction.nextDueAt()).toBeNull();
  });

  it("runs retention and the secret sweep as cleanup", async () => {
    expect(await instance.app.cleanup.run()).toEqual({ purged: 0, deleted: 0, swept: 0 });
  });
});
