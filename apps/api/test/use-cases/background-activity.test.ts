import type { Origin } from "@family-agenda/source-sdk";
import { openViewAccess, type CurrentActivity, type ExtractionRequest, type ExtractionResult } from "@family-agenda/application";
import type { ViewId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";

const minutes = 60 * 1000;

const mail = (id: string, text: string): Origin => ({
  externalId: id,
  occurredAt: new Date("2026-09-14T06:00:00Z"),
  attributes: {},
  content: { kind: "raw-message", text, attachments: [], thread: id },
});

/** A ScriptedExtractor that runs `during` while it reads each message, as a View opened meanwhile would. */
class ObservedExtractor extends ScriptedExtractor {
  during: () => Promise<void> = () => Promise.resolve();

  override async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    await this.during();
    return super.extract(request);
  }
}

describe("The worker's activity on a View", () => {
  let instance: TestInstance;
  let extractor: ObservedExtractor;
  let view: ViewId;
  beforeEach(async () => {
    extractor = new ObservedExtractor();
    instance = await bootForTest({ extractor, blobStore: new InMemoryBlobStore() });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "mailbox", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: {} });
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const created = await instance.app.views.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    view = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  const activity = async () => (await instance.app.views.open(view, { access: openViewAccess }))?.activity;

  const arrive = async (...origins: Origin[]) => {
    testPluginControls.emit("mailbox", origins);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
  };

  it("shows how many messages extraction has read, and nothing once it is done", async () => {
    await arrive(mail("m1", "Erste Mail"), mail("m2", "Zweite Mail"));
    expect(await activity()).toBeNull();
    const seen: (CurrentActivity | null | undefined)[] = [];
    extractor.during = async () => {
      seen.push(await activity());
    };

    await instance.app.extraction.extractPending();

    expect(seen).toEqual([
      { kind: "extracting", done: 0, total: 2 },
      { kind: "extracting", done: 1, total: 2 },
    ]);
    expect(await activity()).toBeNull();
    expect(await instance.app.views.activity(view, { access: openViewAccess })).toBeNull();
  });

  it("ends the activity when extraction stops because the endpoint fails", async () => {
    await arrive(mail("m1", "Erste Mail"), mail("m2", "Zweite Mail"));
    extractor.fail("unreachable");

    await instance.app.extraction.extractPending();

    expect(await activity()).toBeNull();
  });

  it("shows nothing for an activity whose worker stopped in the middle", async () => {
    await arrive(mail("m1", "Erste Mail"));
    let seen: CurrentActivity | null | undefined;
    extractor.during = async () => {
      instance.clock.advance(16 * minutes);
      seen = await activity();
    };

    await instance.app.extraction.extractPending();

    expect(seen).toBeNull();
  });

  it("is refused for an unknown View", async () => {
    expect(await instance.app.views.activity("00000000-0000-4000-8000-000000000000" as ViewId, { access: openViewAccess })).toBeUndefined();
  });
});
