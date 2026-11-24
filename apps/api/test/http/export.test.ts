import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgendaId } from "@family-agenda/domain";
import { unzipSync } from "fflate";
import ICAL from "ical.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakePdf } from "../support/fake-text-extractor";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { bootHttpForTest, bootHttpForTestBelow, signedInCookie, type HttpTestInstance } from "../support/http";
import { testPluginControls, type Origin } from "../support/test-source-plugin";

const minutes = 60 * 1000;
const sourcePassword = "export-test-source-password-7f3k";
const mailPassword = "export-test-mail-password-9q2z";

/** The smallest file a PNG photo is recognised by: its signature, then anything. */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** An attachment of a mail, to find again byte for byte. */
const attachmentBytes = fakePdf({ text: "Elternbrief zum Wandertag" });

const calendarEntry = (key: string, title: string, start: string, end: string): Origin => ({
  externalId: key,
  sender: "Mia's clubs",
  attributes: ["main"],
  link: `https://calendar.example.org/event/${key}`,
  content: { kind: "stated", stated: { kind: "event", title, span: { allDay: false, start, end }, place: "Hall", cancelled: false } },
});

const schoolMail: Origin = {
  externalId: "m1",
  occurredAt: new Date("2026-09-14T06:12:00Z"),
  sender: "klasse5b@schule.example.org",
  attributes: ["main"],
  content: {
    kind: "raw-message",
    text: "Liebe Eltern,\n\nim Anhang der Elternbrief.",
    attachments: [{ filename: "../Elternbrief: 5b.pdf", contentType: "application/pdf", bytes: attachmentBytes }],
  },
};

type Unzipped = Record<string, Uint8Array>;

const text = (files: Unzipped, path: string): string => {
  const file = files[path];
  if (!file) throw new Error(`no ${path} in the export: ${Object.keys(files).join(", ")}`);
  return new TextDecoder().decode(file);
};

const jsonOf = (files: Unzipped, path: string): unknown => JSON.parse(text(files, path));

/** The events of an iCalendar document, as UID, summary and start. */
const eventsOf = (ics: string) =>
  new ICAL.Component(ICAL.parse(ics) as unknown[])
    .getAllSubcomponents("vevent")
    .map((vevent) => `${String(vevent.getFirstPropertyValue("uid"))} ${String(vevent.getFirstPropertyValue("summary"))} ${String(vevent.getFirstPropertyValue("dtstart"))}`)
    .sort();

const contains = (haystack: Uint8Array, needle: string): boolean => Buffer.from(haystack).includes(Buffer.from(needle));

/** Sets up a Family with a photo, two Agendas, a calendar and a mailbox with secrets, and a mail with an attachment. */
async function seed(instance: HttpTestInstance) {
  await instance.installPlugin({ sourceTypeId: "calendar" });
  await instance.installPlugin({ sourceTypeId: "mailbox", needsLlm: true });
  await instance.restart();
  const { app } = instance;
  const mia = await app.familyMembers.add({ name: "Mia", photo: png });
  if (!mia.ok) throw new Error(`adding failed: ${mia.problem}`);
  const agendaIds: AgendaId[] = [];
  for (const memberIds of [[], [mia.id]]) {
    const created = await app.agendas.create({ memberIds, horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    agendaIds.push(created.id);
  }
  await app.sourceTypes.enable("calendar");
  await app.sourceTypes.enable("mailbox");
  const calendar = await app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://calendar.example.org" }, secrets: { password: sourcePassword } });
  const mailbox = await app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: { password: mailPassword } });
  if (!calendar.ok || !mailbox.ok) throw new Error("adding a Source failed");
  const saved = await app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
  if (!saved.ok) throw new Error(`saving failed: ${saved.problem}`);
  testPluginControls.emit("calendar", [
    calendarEntry("piano", "Piano lesson", "2026-09-16T15:00:00Z", "2026-09-16T16:00:00Z"),
    // Long past, so that no feed shows it, but the Export keeps it.
    calendarEntry("summer", "Summer fair", "2026-06-20T10:00:00Z", "2026-06-20T14:00:00Z"),
  ]);
  testPluginControls.emit("mailbox", [schoolMail]);
  instance.clock.advance(15 * minutes);
  await app.polling.pollDue();
  return { agendaIds };
}

describe("the Export", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootHttpForTest();
    cookie = await signedInCookie(instance);
    await instance.post("/admin/recovery-kit/confirm", { saved: "yes" }, { cookie });
  });
  afterEach(async () => {
    await instance.close();
  });

  const download = async () => {
    const response = await instance.get("/admin/export/download", { cookie });
    expect(response.status).toBe(200);
    return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
  };

  it("is a section of the Admin area with a button that downloads it", async () => {
    const page = await instance.get("/admin/export", { cookie });

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('href="/admin/export/download"');
    expect(html).toContain("Download export");
    expect(html).not.toMatch(/backup/i);
    expect(await (await instance.get("/admin", { cookie })).text()).toContain('href="/admin/export"');
  });

  it("names its button in German for a German Family", async () => {
    await instance.app.languages.setLanguage("de");

    expect(await (await instance.get("/admin/export", { cookie })).text()).toContain("Export herunterladen");
  });

  it("gives a signed-out browser the sign-in redirect and no data", async () => {
    await seed(instance);

    for (const path of ["/admin/export", "/admin/export/download"]) {
      const response = await instance.get(path);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/sign-in");
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(await response.text()).not.toContain("Piano lesson");
    }
  });

  it("is a ZIP named by the day, as an attachment kept by no cache", async () => {
    const { response, bytes } = await download();

    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="family-agenda-export-2026-09-14.zip"');
    expect(Object.keys(unzipSync(bytes))).toEqual(["family.json", "items.json"]);
  });

  it("holds each Agenda's feed as iCalendar and its Items as JSON, and every Item besides", async () => {
    const { agendaIds } = await seed(instance);

    const files = unzipSync((await download()).bytes);

    for (const [index, id] of agendaIds.entries()) {
      const feed = await (await instance.get(`/agendas/${id}/feed.ics`)).text();
      const folder = `agendas/agenda-${index + 1}`;
      expect(eventsOf(text(files, `${folder}/feed.ics`))).toEqual(eventsOf(feed));
      const shown = eventsOf(feed).map((line) => line.split("@")[0]);
      expect((jsonOf(files, `${folder}/items.json`) as { id: string }[]).map((item) => item.id).sort()).toEqual(shown.sort());
    }
    const items = (jsonOf(files, "items.json") as { id: string; kind: string; event: { title: string }; concerns: unknown; links: { url: string }[] }[]);
    expect(items.map((item) => item.event.title)).toEqual(["Summer fair", "Piano lesson"]);
    expect(items[1]).toMatchObject({ kind: "event", concerns: "whole-family", links: [{ url: "https://calendar.example.org/event/piano" }] });
    expect(eventsOf(text(files, "agendas/agenda-1/feed.ics"))).toHaveLength(1);
    expect(text(files, "agendas/agenda-1/feed.ics")).not.toContain("URL:");

    const family = (jsonOf(files, "family.json") as { version: number; familyMembers: { name: string; photo: string }[]; agendas: { folder: string }[]; sources: unknown[] });
    expect(family.version).toBe(1);
    expect(family.familyMembers).toMatchObject([{ name: "Mia" }]);
    expect(files[family.familyMembers[0]!.photo]).toEqual(png);
    expect(family.agendas.map((agenda) => agenda.folder)).toEqual(["agendas/agenda-1", "agendas/agenda-2"]);
    expect(family.sources).toMatchObject([{ sourceTypeId: "calendar" }, { sourceTypeId: "mailbox" }]);
  });

  it("holds the stored messages with their attachments, byte for byte", async () => {
    await seed(instance);

    const files = unzipSync((await download()).bytes);

    const [message] = await instance.query("SELECT record_id, blob FROM source_record_attachment");
    const folder = `messages/${String(message?.record_id)}`;
    const described = (jsonOf(files, `${folder}/message.json`) as { sender: string; body: string; attachments: { filename: string; file: string }[] });
    expect(described).toMatchObject({ sender: "klasse5b@schule.example.org", body: "body.txt" });
    expect(text(files, `${folder}/body.txt`)).toContain("im Anhang der Elternbrief.");
    expect(described.attachments).toEqual([
      expect.objectContaining({ filename: "../Elternbrief: 5b.pdf", file: "attachments/0-_Elternbrief_ 5b.pdf" }),
    ]);
    const blob = await readFile(join(instance.blobDirectory, instance.app.familyId, String(message?.blob)));
    expect(files[`${folder}/${described.attachments[0]!.file}`]).toEqual(new Uint8Array(blob));
    expect(files[`${folder}/attachments/0-_Elternbrief_ 5b.pdf`]).toEqual(attachmentBytes);
  });

  it("holds no secret: no Source's password, no Agenda Link, no family key", async () => {
    const { agendaIds } = await seed(instance);

    const { bytes } = await download();

    for (const secret of [sourcePassword, mailPassword, ...agendaIds, instance.app.recoveryKit.contents().masterKey]) {
      expect(contains(bytes, secret), secret).toBe(false);
    }
    expect(contains(bytes, "Piano lesson")).toBe(true);
  });
});

describe("the Export of what is no longer stored", () => {
  it("names no file for an attachment that is gone, nor for a purged message's content", async () => {
    const extractor = new ScriptedExtractor();
    extractor.script("Elternbrief", [extracted({ title: "Elternabend", date: { day: 15, month: 9, weekday: "tuesday" }, evidence: "im Anhang der Elternbrief" })]);
    const instance = await bootHttpForTest({}, { extractor });
    try {
      let cookie = await signedInCookie(instance);
      await instance.post("/admin/recovery-kit/confirm", { saved: "yes" }, { cookie });
      await seed(instance);
      await instance.app.extraction.extractPending();
      const download = async () => unzipSync(new Uint8Array(await (await instance.get("/admin/export/download", { cookie })).arrayBuffer()));
      const [message] = await instance.query("SELECT record_id, blob FROM source_record_attachment");
      const folder = `messages/${String(message?.record_id)}`;
      await rm(join(instance.blobDirectory, instance.app.familyId, String(message?.blob)));

      const gone = await download();

      expect(jsonOf(gone, `${folder}/message.json`)).toMatchObject({ body: "body.txt", attachments: [{ filename: "../Elternbrief: 5b.pdf", file: null }] });
      expect(Object.keys(gone).filter((path) => path.startsWith(`${folder}/attachments/`))).toEqual([]);

      // Once its Event has ended, retention purges the mail's content.
      instance.clock.advance(6 * 24 * 60 * minutes);
      expect(await instance.app.retention.purge()).toMatchObject({ purged: 1 });
      cookie = await signedInCookie(instance);
      const purged = await download();

      expect(jsonOf(purged, `${folder}/message.json`)).toMatchObject({ body: null, attachments: [], purgedAt: expect.any(String) as unknown });
      expect(purged[`${folder}/body.txt`]).toBeUndefined();
    } finally {
      await instance.close();
    }
  });
});

/** A BlobStore whose every file streams as a huge one, made only as it is read; it counts what it made. */
class HugeBlobStore extends InMemoryBlobStore {
  produced = 0;

  override stream(): Promise<AsyncIterable<Uint8Array>> {
    return Promise.resolve(ReadableStream.from(this.huge()));
  }

  private *huge(): Generator<Uint8Array> {
    const chunk = new Uint8Array(1024 * 1024);
    // 64 GiB, far more than the test process could hold.
    for (let index = 0; index < 64 * 1024; index++) {
      this.produced += chunk.length;
      yield chunk;
    }
  }
}

describe("the Export of huge files", () => {
  it("streams them as it is read, holding only a little of them at a time", async () => {
    const blobs = new HugeBlobStore();
    const instance = await bootHttpForTest({}, { blobStore: blobs });
    try {
      const cookie = await signedInCookie(instance);
      await instance.post("/admin/recovery-kit/confirm", { saved: "yes" }, { cookie });
      await seed(instance);

      const response = await instance.get("/admin/export/download", { cookie });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let received = 0;
      while (received < 64 * 1024 * 1024) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.length;
      }
      await reader.cancel();

      expect(received).toBeGreaterThanOrEqual(64 * 1024 * 1024);
      // What was made but not yet read stays within a few chunks.
      expect(blobs.produced - received).toBeLessThan(16 * 1024 * 1024);
    } finally {
      await instance.close();
    }
  });
});

describe("the Export below a path prefix", () => {
  it("is linked and downloaded below the prefix", async () => {
    const prefix = "/agenda";
    const instance = await bootHttpForTestBelow(prefix);
    try {
      const cookie = await signedInCookie(instance);
      await instance.post(`${prefix}/admin/recovery-kit/confirm`, { saved: "yes" }, { cookie });

      expect(await (await instance.get(`${prefix}/admin/export`, { cookie })).text()).toContain(`href="${prefix}/admin/export/download"`);
      const response = await instance.get(`${prefix}/admin/export/download`, { cookie });
      expect(response.status).toBe(200);
      expect(Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer())))).toContain("family.json");
      expect((await instance.get(`${prefix}/admin/export/download`)).headers.get("location")).toBe(`${prefix}/admin/sign-in`);
    } finally {
      await instance.close();
    }
  });
});
