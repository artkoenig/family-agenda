import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { photos } from "../support/photos";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls } from "../support/test-source-plugin";

const password = "correct horse battery";

describe("blobs kept in the layout before Family folders", () => {
  let instance: HttpTestInstance;
  let extractor: ScriptedExtractor;
  beforeEach(async () => {
    extractor = new ScriptedExtractor();
    instance = await bootHttpForTest({}, { extractor, sourcePlugins: [{ sourceTypeId: "school-mail", needsLlm: true }] });
  });
  afterEach(async () => {
    await instance.close();
  });

  /** Moves the Family's blobs to the top level of the blob directory, as releases before Family folders kept them. */
  const intoOldLayout = async () => {
    const folder = join(instance.blobDirectory, instance.app.familyId);
    for (const blob of await readdir(folder)) await rename(join(folder, blob), join(instance.blobDirectory, blob));
    await rm(folder, { recursive: true });
  };

  it("loads a Family Member's photo and a message attachment on an Instance that started with them", async () => {
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    const added = await instance.app.familyMembers.add({ name: "Mia", photo: photos.png });
    if (!added.ok) throw new Error("adding failed");
    await instance.app.sourceTypes.enable("school-mail");
    await instance.app.sources.add({ sourceTypeId: "school-mail", plain: { url: "imap.example.org" }, secrets: {} });
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    extractor.script("Elternabend", [extracted({ title: "Elternabend", date: { daysAfter: 1 }, evidence: "Morgen ist Elternabend" })]);
    testPluginControls.emit("school-mail", [
      {
        externalId: "m1",
        occurredAt: new Date("2026-09-14T06:00:00Z"),
        attributes: ["main"],
        content: {
          kind: "raw-message",
          text: "Subject: Elternabend\n\nMorgen ist Elternabend.",
          attachments: [{ filename: "Einladung.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) }],
        },
      },
    ]);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
    const agenda = await (await instance.get(`/agendas/${created.id}`)).text();
    const link = /<a href="(\/admin\/messages\/[0-9a-f-]+)"/.exec(agenda)![1]!;

    await intoOldLayout();
    await instance.restart();
    const cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));

    const photo = await instance.get(`/family-members/${added.id}/photo`);
    expect(photo.status).toBe(200);
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(photos.png);
    const pdf = await instance.get(`${link}/attachments/0`, { cookie });
    expect(pdf.status).toBe(200);
    expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
