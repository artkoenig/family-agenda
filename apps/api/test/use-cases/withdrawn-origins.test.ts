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

const message = (id: string, text: string): Origin => ({
  externalId: id,
  occurredAt: new Date("2026-09-14T06:12:00Z"),
  sender: "Frau Berger", attributes: ["main"],
  content: { kind: "raw-message", text, attachments: [] },
});

const trip = "Am Freitag, 18.09., ist der Wandertag der 5b.";

describe("Origins a Source withdraws, such as deleted chat messages", () => {
  let instance: TestInstance;
  let extractor: ScriptedExtractor;
  let blobs: InMemoryBlobStore;
  let agenda: AgendaId;
  beforeEach(async () => {
    extractor = new ScriptedExtractor();
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
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    agenda = created.id;
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
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    return (page?.days ?? []).flatMap((day) => day.items.map((item) => item.title));
  };

  it("takes the Item off the timeline at once, and removes the message with its files", async () => {
    testPluginControls.emit("chat", [message("$m1", trip)]);
    await run();
    expect(await titles()).toEqual(["Wandertag 5b"]);
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    const [extracted] = page!.days.flatMap((day) => day.items)[0]!.messages;

    testPluginControls.withdraw("chat", ["$m1"]);
    await run();

    expect(await titles()).toEqual([]);
    expect(await instance.app.messages.open(extracted!.id)).toBeNull();
    expect(blobs.size).toBe(0);
    expect(await instance.query("SELECT sender, body FROM source_record")).toEqual([{ sender: null, body: null }]);
    expect(await instance.query("SELECT count(*)::int AS n FROM source_record_attachment")).toEqual([{ n: 0 }]);
    expect(await instance.query("SELECT count(*)::int AS n FROM item")).toEqual([{ n: 0 }]);
  });

  it("records a withdrawn message arriving again as no longer withdrawn, without reading it again", async () => {
    testPluginControls.withdraw("chat", ["$m1"], [message("$m1", trip)]);
    await run();
    expect(await titles()).toEqual([]);
    expect(await instance.query("SELECT withdrawn_at IS NOT NULL AS withdrawn FROM source_record")).toEqual([{ withdrawn: true }]);

    testPluginControls.emit("chat", [message("$m1", trip)]);
    await run();

    expect(await titles()).toEqual([]);
    expect(
      await instance.query("SELECT withdrawn_at, body, processed_at FROM source_record WHERE external_id = '$m1'"),
    ).toEqual([{ withdrawn_at: null, body: null, processed_at: null }]);
    expect(blobs.size).toBe(0);
  });

  it("ignores withdrawing an Origin it never recorded", async () => {
    testPluginControls.withdraw("chat", ["$unknown"]);
    await run();

    const [source] = await instance.app.sources.list();
    expect(source?.health.status).toBe("ok");
  });
});
