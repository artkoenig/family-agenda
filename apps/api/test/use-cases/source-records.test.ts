import { createHash } from "node:crypto";
import type { Origin } from "@family-agenda/source-sdk";
import { openAgendaAccess } from "@family-agenda/application";
import type { BlobRef } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const letter = new TextEncoder().encode("%PDF-1.7 Elternbrief");

const mail: Origin = {
  externalId: "<m1@schule.example.org>",
  occurredAt: new Date("2026-09-14T06:12:00Z"),
  sender: "klasse5b@schule.example.org", attributes: ["main"],
  content: {
    kind: "raw-message",
    text: "Liebe Eltern, im Anhang der Elternbrief.",
    attachments: [{ filename: "elternbrief.pdf", contentType: "application/pdf", bytes: letter }],
  },
};

/** A calendar entry, as a structured Source emits it. */
const entry = (key: string): Origin => ({
  externalId: key,
  attributes: ["main"],
  content: { kind: "stated", stated: { kind: "event", title: "Piano lesson", span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" }, place: null, cancelled: false } },
});

describe("Source Records, as what a Source delivered is stored", () => {
  let instance: TestInstance;
  let blobs: InMemoryBlobStore;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    blobs = new InMemoryBlobStore();
    instance = await bootForTest({ blobStore: blobs });
    await writeTestPluginPackage(instance.publishedPlugins, { sourceTypeId: "mailbox", needsLlm: true });
    await writeTestPluginPackage(instance.publishedPlugins, { sourceTypeId: "calendar" });
    await instance.restart();
    for (const type of ["mailbox", "calendar"]) {
      await instance.app.sourceTypes.enable(type);
      const added = await instance.app.sources.add({ sourceTypeId: type, plain: { url: `${type}.example.org` }, secrets: {} });
      if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    }
  });
  afterEach(async () => {
    await instance.close();
  });

  const run = async () => {
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
  };

  it("stores a message as one record, its text in Postgres and only its attachments behind the BlobStore", async () => {
    testPluginControls.emit("mailbox", [mail]);
    await run();

    const records = await instance.query(
      "SELECT external_id, occurred_at, sender, subject, body, processed_at, withdrawn_at FROM source_record",
    );
    expect(records).toEqual([
      {
        external_id: "<m1@schule.example.org>",
        occurred_at: new Date("2026-09-14T06:12:00Z"),
        sender: "klasse5b@schule.example.org",
        subject: null,
        body: "Liebe Eltern, im Anhang der Elternbrief.",
        processed_at: null,
        withdrawn_at: null,
      },
    ]);
    expect(await instance.query("SELECT filename, media_type, sha256, size FROM source_record_attachment")).toEqual([
      { filename: "elternbrief.pdf", media_type: "application/pdf", sha256: sha256(letter), size: letter.byteLength },
    ]);
    const [attachment] = await instance.query("SELECT blob FROM source_record_attachment");
    expect(await blobs.get(attachment!.blob as BlobRef)).toEqual(letter);
    expect(blobs.size).toBe(1);
  });

  it("keeps one record per external id, however often the Source delivers it", async () => {
    testPluginControls.emit("mailbox", [mail]);
    await run();
    testPluginControls.emit("mailbox", [mail]);
    await run();

    expect(await instance.query("SELECT count(*)::int AS n FROM source_record")).toEqual([{ n: 1 }]);
    expect(await instance.query("SELECT count(*)::int AS n FROM source_record_attachment")).toEqual([{ n: 1 }]);
    expect(blobs.size).toBe(1);
  });

  it("shows a withdrawn calendar entry again once it arrives again", async () => {
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    const titles = async () => {
      const page = await openTimeline(instance.app, created.id, { access: openAgendaAccess });
      return (page?.days ?? []).flatMap((day) => day.items.map((item) => item.title));
    };
    testPluginControls.emit("calendar", [entry("piano")]);
    await run();
    testPluginControls.withdraw("calendar", ["piano"]);
    await run();
    expect(await titles()).toEqual([]);

    testPluginControls.emit("calendar", [entry("piano")]);
    await run();

    expect(await titles()).toEqual(["Piano lesson"]);
    expect(await instance.query("SELECT withdrawn_at FROM source_record WHERE external_id = 'piano'")).toEqual([{ withdrawn_at: null }]);
  });

  it("keeps every Item with the detail row of its kind, enforced by the schema", async () => {
    testPluginControls.emit("calendar", [entry("piano")]);
    await run();
    const [item] = await instance.query("SELECT id, record_id FROM item");
    expect(await instance.query(`SELECT title, kind FROM event WHERE item_id = '${String(item!.id)}'`)).toEqual([{ title: "Piano lesson", kind: "event" }]);

    await expect(instance.query(`INSERT INTO item (kind, record_id) VALUES ('task', '${String(item!.record_id)}')`)).rejects.toThrow(/has no task row/);
    await expect(instance.query(`DELETE FROM event WHERE item_id = '${String(item!.id)}'`)).rejects.toThrow(/lost its event row/);
    await expect(instance.query(`INSERT INTO task (item_id, kind, title) VALUES ('${String(item!.id)}', 'task', 'Wrong kind')`)).rejects.toThrow();
    await instance.query(`DELETE FROM item WHERE id = '${String(item!.id)}'`);
    expect(await instance.query("SELECT count(*)::int AS n FROM event")).toEqual([{ n: 0 }]);
  });
});
