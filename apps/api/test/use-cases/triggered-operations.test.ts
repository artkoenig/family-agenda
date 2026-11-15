import type { Origin } from "../support/test-source-plugin";
import { openAgendaAccess } from "@family-agenda/application";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../../src/http/app";
import { createTriggerApp } from "../../src/triggered-operations";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls } from "../support/test-source-plugin";

const minutes = 60 * 1000;
const days = 24 * 60 * minutes;
const token = "s3cret-token";
const bearer = { authorization: `Bearer ${token}` };
const log = { warn: () => {}, error: () => {} };

const mail = (id: string, text: string): Origin => ({
  externalId: id,
  occurredAt: new Date("2026-09-14T06:00:00Z"),
  attributes: ["main"],
  content: { kind: "raw-message", text, attachments: [] },
});

describe("Triggering the worker's work from outside the core", () => {
  let instance: TestInstance;
  let sourceId: string;
  beforeEach(async () => {
    const extractor = new ScriptedExtractor();
    extractor.script("Wandertag", [extracted({ title: "Wandertag", date: { day: 18, month: 9, weekday: "friday" }, evidence: "Freitag, 18.09., ist der Wandertag" })]);
    instance = await bootForTest({ extractor, blobStore: new InMemoryBlobStore() });
    await instance.installPlugin({ sourceTypeId: "mailbox", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    const added = await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    sourceId = added.id;
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
  });
  afterEach(async () => {
    await instance.close();
  });

  const trigger = async (name: string) => {
    const response = await createTriggerApp(instance.triggeredWork(), { token, log }).request(`/operations/${name}`, { method: "POST", headers: bearer });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const items = () => instance.query("SELECT count(*)::int AS n FROM item");

  it("polls a due Source, extracts its message and answers with what ran", async () => {
    testPluginControls.emit("mailbox", [mail("m1", "Am Freitag, 18.09., ist der Wandertag.")]);
    instance.clock.advance(15 * minutes);

    const { status, body } = await trigger("due-work");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      polled: { ok: true, report: { ran: [sourceId], failed: [] } },
      extracted: { ok: true, report: { failed: [] } },
    });
    expect((body.extracted as { report: { extracted: unknown[] } }).report.extracted).toHaveLength(1);
    expect(await items()).toEqual([{ n: 1 }]);
  });

  it("does not run a Source twice when due work is triggered during a run", async () => {
    testPluginControls.emit("mailbox", [mail("m1", "Am Freitag, 18.09., ist der Wandertag.")]);
    instance.clock.advance(15 * minutes);
    const app = createTriggerApp(instance.triggeredWork(), { token, log });
    const pollsBefore = testPluginControls.runs("mailbox").length;

    const answers = await Promise.all([1, 2].map(async () => (await app.request("/operations/due-work", { method: "POST", headers: bearer })).json()));

    expect(testPluginControls.runs("mailbox").length).toBe(pollsBefore + 1);

    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toMatchObject({ polled: { report: { ran: [sourceId] } } });
    expect(await items()).toEqual([{ n: 1 }]);
  });

  it("purges the text of messages past their retention", async () => {
    testPluginControls.emit("mailbox", [mail("m1", "Am Freitag, 18.09., ist der Wandertag.")]);
    instance.clock.advance(15 * minutes);
    await trigger("due-work");
    instance.clock.advance(400 * days);

    const { status, body } = await trigger("purge");

    expect(status).toBe(200);
    expect(body).toMatchObject({ purged: 1 });
  });

  it("removes the secrets nothing refers to", async () => {
    await instance.app.secrets.put("left behind by a crash");
    await instance.query("UPDATE secret SET created_at = '2026-09-14T05:00:00Z'");

    expect(await trigger("secret-sweep")).toEqual({ status: 200, body: { removed: 1 } });
  });

  it("offers none of them on the port that serves the pages", async () => {
    const pages = createHttpApp(instance.app, { trustProxy: false, agendaAccess: openAgendaAccess });
    testPluginControls.emit("mailbox", [mail("m1", "Am Freitag, 18.09., ist der Wandertag.")]);
    instance.clock.advance(15 * minutes);
    const runsBefore = await instance.query("SELECT count(*)::int AS n FROM source_run");

    for (const name of ["due-work", "purge", "secret-sweep"]) {
      expect((await pages.request(`/operations/${name}`, { method: "POST", headers: bearer })).status).not.toBe(200);
    }
    expect(await instance.query("SELECT count(*)::int AS n FROM source_run")).toEqual(runsBefore);
    expect(await items()).toEqual([{ n: 0 }]);
  });
});

describe("Triggering the Admins' operations from outside the core", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
  });
  afterEach(async () => {
    await instance.close();
  });

  const trigger = (name: string, body: unknown) =>
    createTriggerApp(instance.triggeredWork(), { token, log }).request(`/operations/${name}`, { method: "POST", headers: bearer, body: JSON.stringify(body) });

  it("enters the first Admin, after which the setup page is not found", async () => {
    const pages = createHttpApp(instance.app, { trustProxy: false, agendaAccess: openAgendaAccess });
    expect((await pages.request("/setup")).status).toBe(200);

    const response = await trigger("enter-admin", { email: "anna@example.org" });

    expect(await response.json()).toEqual({ email: "anna@example.org", outcome: "first" });
    expect((await pages.request("/setup")).status).toBe(404);
  });

  it("resets the entered Admin's password, who can then sign in with it", async () => {
    await trigger("enter-admin", { email: "anna@example.org" });

    const answer = (await (await trigger("reset-admin-password", { email: "anna@example.org" })).json()) as { newPassword: string };

    expect((await instance.app.admins.signIn({ email: "anna@example.org", password: answer.newPassword, client: "192.0.2.1" })).ok).toBe(true);
  });
});
