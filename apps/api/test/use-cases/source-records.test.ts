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

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const letter = new TextEncoder().encode("%PDF-1.7 Elternbrief");

const mail: Origin = {
  externalId: "<m1@schule.example.org>",
  occurredAt: new Date("2026-09-14T06:12:00Z"),
  attributes: { sender: "klasse5b@schule.example.org" },
  content: {
    kind: "raw-message",
    text: "Liebe Eltern, im Anhang der Elternbrief.",
    attachments: [{ filename: "elternbrief.pdf", contentType: "application/pdf", bytes: letter }],
    thread: "<m1@schule.example.org>",
  },
};

/** A calendar entry, as a structured Source emits it. */
const entry = (key: string): Origin => ({
  externalId: key,
  occurredAt: new Date("2026-09-14T07:00:00Z"),
  attributes: { calendar: "Clubs" },
  content: {
    kind: "revisions",
    revisions: [
      {
        itemKind: "event",
        itemKey: key,
        action: "create",
        fields: { title: "Piano lesson", span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" } },
      },
    ],
  },
});

describe("Source Records, as what a Source delivered is stored", () => {
  let instance: TestInstance;
  let blobs: InMemoryBlobStore;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    blobs = new InMemoryBlobStore();
    instance = await bootForTest({ blobStore: blobs });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "mailbox", needsLlm: true });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "calendar" });
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

  it("stores a message as one record, its text in Postgres and its files behind the BlobStore by reference and hash", async () => {
    testPluginControls.emit("mailbox", [mail]);
    await run();

    const records = await instance.query(
      "SELECT external_id, occurred_at, sender, subject, body, raw_sha256, raw_size, processed_at, withdrawn_at FROM source_record",
    );
    const text = new TextEncoder().encode("Liebe Eltern, im Anhang der Elternbrief.");
    expect(records).toEqual([
      {
        external_id: "<m1@schule.example.org>",
        occurred_at: new Date("2026-09-14T06:12:00Z"),
        sender: "klasse5b@schule.example.org",
        subject: null,
        body: "Liebe Eltern, im Anhang der Elternbrief.",
        raw_sha256: sha256(text),
        raw_size: text.byteLength,
        processed_at: null,
        withdrawn_at: null,
      },
    ]);
    expect(await instance.query("SELECT filename, media_type, sha256, size FROM source_record_attachment")).toEqual([
      { filename: "elternbrief.pdf", media_type: "application/pdf", sha256: sha256(letter), size: letter.byteLength },
    ]);
    const [files] = await instance.query("SELECT raw_blob, blob FROM source_record JOIN source_record_attachment ON record_id = source_record.id");
    expect(await blobs.get(files!.raw_blob as BlobRef)).toEqual(text);
    expect(await blobs.get(files!.blob as BlobRef)).toEqual(letter);
  });

  it("keeps one record per external id, however often the Source delivers it", async () => {
    testPluginControls.emit("mailbox", [mail]);
    await run();
    testPluginControls.emit("mailbox", [mail]);
    await run();

    expect(await instance.query("SELECT count(*)::int AS n FROM source_record")).toEqual([{ n: 1 }]);
    expect(await instance.query("SELECT count(*)::int AS n FROM source_record_attachment")).toEqual([{ n: 1 }]);
    expect(blobs.size).toBe(2);
  });

  it("shows a withdrawn calendar entry again once it arrives again", async () => {
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 7 });
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
});
