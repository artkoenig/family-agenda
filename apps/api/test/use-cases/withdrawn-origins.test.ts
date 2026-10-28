import type { Origin } from "@family-agenda/source-sdk";
import { openViewAccess } from "@family-agenda/application";
import type { ViewId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";

const minutes = 60 * 1000;

const message = (id: string, text: string): Origin => ({
  externalId: id,
  occurredAt: new Date("2026-09-14T06:12:00Z"),
  attributes: { sender: "Frau Berger" },
  content: { kind: "raw-message", text, attachments: [] },
});

const trip = "Am Freitag, 18.09., ist der Wandertag der 5b.";

describe("Origins a Source withdraws, such as deleted chat messages", () => {
  let instance: TestInstance;
  let blobs: InMemoryBlobStore;
  let view: ViewId;
  beforeEach(async () => {
    const extractor = new ScriptedExtractor();
    extractor.script("Wandertag", [
      extracted({ title: "Wandertag 5b", date: { day: 18, month: 9, weekday: "friday" }, evidence: "Freitag, 18.09., ist der Wandertag" }),
    ]);
    blobs = new InMemoryBlobStore();
    instance = await bootForTest({ extractor, blobStore: blobs });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "chat", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("chat");
    const added = await instance.app.sources.add({ sourceTypeId: "chat", plain: { url: "chat.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const created = await instance.app.views.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    view = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  const run = async () => {
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
  };

  const titles = async () => {
    const page = await instance.app.views.open(view, { access: openViewAccess });
    return (page?.days ?? []).flatMap((day) => day.items.map((item) => item.title));
  };

  it("takes the Item off the timeline at once, and removes the message with its files", async () => {
    testPluginControls.emit("chat", [message("$m1", trip)]);
    await run();
    expect(await titles()).toEqual(["Wandertag 5b"]);
    const page = await instance.app.views.open(view, { access: openViewAccess });
    const [messageId] = page!.days.flatMap((day) => day.items)[0]!.messages;

    testPluginControls.withdraw("chat", ["$m1"]);
    await run();

    expect(await titles()).toEqual([]);
    expect(await instance.app.messages.open(messageId!)).toBeNull();
    expect(blobs.size).toBe(0);
    expect(await instance.query("SELECT accepted, rejection FROM revisions")).toEqual([
      { accepted: false, rejection: "origin-withdrawn" },
    ]);
  });

  it("never records a withdrawn Origin again, nor one withdrawn in the run that brought it", async () => {
    testPluginControls.withdraw("chat", ["$m1"], [message("$m1", trip)]);
    await run();
    expect(await titles()).toEqual([]);

    testPluginControls.emit("chat", [message("$m1", trip)]);
    await run();

    expect(await titles()).toEqual([]);
    expect(await instance.query("SELECT count(*)::int AS n FROM raw_messages")).toEqual([{ n: 0 }]);
    expect(blobs.size).toBe(0);
  });

  it("ignores withdrawing an Origin it never recorded", async () => {
    testPluginControls.withdraw("chat", ["$unknown"]);
    await run();

    const [source] = await instance.app.sources.list();
    expect(source?.health.status).toBe("ok");
  });
});
