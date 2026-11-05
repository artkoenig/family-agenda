import type { Origin } from "@family-agenda/source-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, extractedTask, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";

const minutes = 60 * 1000;
const days = 24 * 60 * minutes;

const message = (id: string, text: string, occurredAt = "2026-09-14T06:12:00Z", withFile = false): Origin => ({
  externalId: id,
  occurredAt: new Date(occurredAt),
  sender: "Frau Berger",
  attributes: ["main"],
  content: {
    kind: "raw-message",
    text,
    attachments: withFile ? [{ filename: "brief.pdf", contentType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7") }] : [],
  },
});

const calendarEntry: Origin = {
  externalId: "piano",
  attributes: ["main"],
  content: { kind: "stated", stated: { kind: "event", title: "Piano", span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" }, place: null, cancelled: false } },
};

describe("Retention: purging the content of messages", () => {
  let instance: TestInstance;
  let blobs: InMemoryBlobStore;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    const extractor = new ScriptedExtractor();
    extractor.script("Wandertag", [extracted({ title: "Wandertag", date: { day: 18, month: 9, weekday: "friday" }, evidence: "Freitag, 18.09., ist der Wandertag" })]);
    extractor.script("Mappe", [], [extractedTask({ title: "Mappe abgeben", deadline: { day: 25, month: 9 }, evidence: "Mappe bis 25.09." })]);
    extractor.script("Turnbeutel", [], [extractedTask({ title: "Turnbeutel mitbringen", bring: ["Turnbeutel"], evidence: "Turnbeutel" })]);
    blobs = new InMemoryBlobStore();
    instance = await bootForTest({ extractor, blobStore: blobs });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "chat", needsLlm: true });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "calendar" });
    await instance.restart();
    for (const type of ["chat", "calendar"]) {
      await instance.app.sourceTypes.enable(type);
      const added = await instance.app.sources.add({ sourceTypeId: type, plain: { url: `${type}.example.org` }, secrets: {} });
      if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    }
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
  });
  afterEach(async () => {
    await instance.close();
  });

  const run = async () => {
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
  };
  const advanceDays = (count: number) => {
    instance.clock.advance(count * days);
  };
  const records = () => instance.query("SELECT external_id, body IS NULL AS cleared, purged_at IS NOT NULL AS purged FROM source_record ORDER BY external_id");

  it("purges the content of a message once its Event has ended, and keeps its Item", async () => {
    testPluginControls.emit("chat", [message("$m1", "Am Freitag, 18.09., ist der Wandertag.", undefined, true)]);
    await run();

    await instance.app.retention.purge();
    expect(await records()).toEqual([{ external_id: "$m1", cleared: false, purged: false }]);
    expect(blobs.size).toBe(1);

    advanceDays(6);
    expect(await instance.app.retention.purge()).toEqual({ purged: 1, deleted: 0 });

    expect(await records()).toEqual([{ external_id: "$m1", cleared: true, purged: true }]);
    expect(await instance.query("SELECT sender, subject FROM source_record")).toEqual([{ sender: null, subject: null }]);
    expect(await instance.query("SELECT count(*)::int AS n FROM source_record_attachment")).toEqual([{ n: 0 }]);
    expect(blobs.size).toBe(0);
    expect(await instance.query("SELECT count(*)::int AS n FROM item")).toEqual([{ n: 1 }]);
  });

  it("shows a purged message in the Origin view as a tombstone", async () => {
    testPluginControls.emit("chat", [message("$m1", "Am Freitag, 18.09., ist der Wandertag.")]);
    await run();
    const [{ id }] = (await instance.query("SELECT id FROM source_record")) as [{ id: string }];
    expect((await instance.app.messages.open(id as never))?.purgedAt).toBeNull();

    advanceDays(6);
    await instance.app.retention.purge();

    const opened = await instance.app.messages.open(id as never);
    expect(opened?.purgedAt).toEqual(instance.clock.now());
    expect(opened?.text).toBe("");
    expect(opened?.items).toHaveLength(1);
  });

  it("keeps a Task's message until it is done or past its Deadline, and without a Deadline until it is done", async () => {
    testPluginControls.emit("chat", [message("$deadline", "Mappe bis 25.09."), message("$open", "Turnbeutel")]);
    await run();

    advanceDays(6);
    await instance.app.retention.purge();
    expect(await records()).toEqual([
      { external_id: "$deadline", cleared: false, purged: false },
      { external_id: "$open", cleared: false, purged: false },
    ]);

    advanceDays(20);
    await instance.app.retention.purge();
    expect(await records()).toEqual([
      { external_id: "$deadline", cleared: true, purged: true },
      { external_id: "$open", cleared: false, purged: false },
    ]);

    await instance.query("UPDATE task SET status = 'done', done_at = now() WHERE title = 'Turnbeutel mitbringen'");
    await instance.app.retention.purge();
    expect(await records()).toEqual([
      { external_id: "$deadline", cleared: true, purged: true },
      { external_id: "$open", cleared: true, purged: true },
    ]);
  });

  it("purges a message whose Items were all deleted, and one that yielded none", async () => {
    testPluginControls.emit("chat", [message("$m1", "Am Freitag, 18.09., ist der Wandertag."), message("$nothing", "Guten Morgen")]);
    await run();
    await instance.query("DELETE FROM item");

    await instance.app.retention.purge();

    expect(await records()).toEqual([
      { external_id: "$m1", cleared: true, purged: true },
      { external_id: "$nothing", cleared: true, purged: true },
    ]);
  });

  it("purges a message whose Items still need it once it is older than the retention period, keeping its row", async () => {
    testPluginControls.emit("chat", [message("$open", "Turnbeutel")]);
    await run();

    advanceDays(179);
    await instance.app.retention.purge();
    expect(await records()).toEqual([{ external_id: "$open", cleared: false, purged: false }]);

    advanceDays(2);
    expect(await instance.app.retention.purge()).toEqual({ purged: 1, deleted: 0 });
    expect(await records()).toEqual([{ external_id: "$open", cleared: true, purged: true }]);
    expect(await instance.query("SELECT count(*)::int AS n FROM item")).toEqual([{ n: 1 }]);
  });

  it("keeps a message that was not extracted until the retention period ends, then purges it with its row", async () => {
    // No LLM endpoint answers, so extraction fails and the message stays pending.
    await instance.query("DELETE FROM llm_endpoint");
    testPluginControls.emit("chat", [message("$m1", "Am Freitag, 18.09., ist der Wandertag.", undefined, true)]);
    await run();
    expect(await instance.query("SELECT processed_at FROM source_record")).toEqual([{ processed_at: null }]);

    advanceDays(100);
    await instance.app.retention.purge();
    expect(await records()).toEqual([{ external_id: "$m1", cleared: false, purged: false }]);
    expect(blobs.size).toBe(1);
    expect(await instance.app.extraction.waiting()).toBe(1);

    advanceDays(81);
    expect(await instance.app.retention.purge()).toEqual({ purged: 1, deleted: 1 });
    expect(await records()).toEqual([]);
    expect(blobs.size).toBe(0);
  });

  it("ignores a message older than the retention period on arrival, whatever the Source delivers", async () => {
    testPluginControls.emit("chat", [message("$old", "Am Freitag, 18.09., ist der Wandertag.", "2026-02-01T08:00:00Z", true)]);
    await run();

    expect(await records()).toEqual([]);
    expect(blobs.size).toBe(0);
  });

  it("deletes the row of a purged message once it has no Item and is older than the period", async () => {
    testPluginControls.emit("chat", [message("$m1", "Am Freitag, 18.09., ist der Wandertag.")]);
    await run();
    advanceDays(6);
    await instance.app.retention.purge();
    expect(await records()).toHaveLength(1);

    await instance.query("DELETE FROM item");
    await instance.app.retention.purge();
    expect(await records()).toHaveLength(1);

    advanceDays(180);
    expect(await instance.app.retention.purge()).toEqual({ purged: 0, deleted: 1 });
    expect(await records()).toEqual([]);
  });

  it("does not read a purged message again when it arrives again within the period", async () => {
    testPluginControls.emit("chat", [message("$m1", "Am Freitag, 18.09., ist der Wandertag.")]);
    await run();
    advanceDays(6);
    await instance.app.retention.purge();
    await instance.query("DELETE FROM item");

    testPluginControls.emit("chat", [message("$m1", "Am Freitag, 18.09., ist der Wandertag.", undefined, true)]);
    await run();

    expect(await records()).toEqual([{ external_id: "$m1", cleared: true, purged: true }]);
    expect(await instance.query("SELECT count(*)::int AS n FROM item")).toEqual([{ n: 0 }]);
    expect(blobs.size).toBe(0);
  });

  it("leaves stated Source Records untouched", async () => {
    testPluginControls.emit("calendar", [calendarEntry]);
    await run();

    advanceDays(400);
    expect(await instance.app.retention.purge()).toEqual({ purged: 0, deleted: 0 });

    expect(await instance.query("SELECT external_id, purged_at FROM source_record")).toEqual([{ external_id: "piano", purged_at: null }]);
    expect(await instance.query("SELECT count(*)::int AS n FROM item")).toEqual([{ n: 1 }]);
  });
});
