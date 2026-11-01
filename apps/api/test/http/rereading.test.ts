import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls } from "../support/test-source-plugin";

const password = "correct horse battery";

describe("re-reading messages over HTTP", () => {
  let instance: HttpTestInstance;
  let extractor: ScriptedExtractor;
  let cookie: string;
  let mailbox: string;
  beforeEach(async () => {
    extractor = new ScriptedExtractor();
    instance = await bootHttpForTest(
      {},
      {
        extractor,
        blobStore: new InMemoryBlobStore(),
        sourcePlugins: [
          { sourceTypeId: "school-mail", needsLlm: true },
          { sourceTypeId: "calendar", needsLlm: false },
        ],
      },
    );
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("school-mail");
    const added = await instance.app.sources.add({ sourceTypeId: "school-mail", plain: { url: "imap.example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    mailbox = added.id;
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    extractor.script("Wandertag", [extracted({ title: "Wandertag", date: { daysAfter: 1 }, evidence: "Morgen ist Wandertag" })]);
    testPluginControls.emit("school-mail", [
      {
        externalId: "m1",
        occurredAt: new Date("2026-09-14T06:00:00Z"),
        attributes: { sender: "lehrerin@schule.example.org" },
        content: { kind: "raw-message", text: "Morgen ist Wandertag.", attachments: [] },
      },
    ]);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
  });
  afterEach(async () => {
    await instance.close();
  });

  const waiting = async () =>
    (await instance.query("SELECT count(*)::int AS count FROM source_record WHERE processed_at IS NULL"))[0]?.count;

  it("re-reads all messages from the LLM endpoint's page", async () => {
    expect(await (await instance.get("/admin/llm", { cookie })).text()).toContain('action="/admin/llm/reread"');

    const reread = await instance.post("/admin/llm/reread", {}, { cookie });

    expect(reread.status).toBe(303);
    expect(reread.headers.get("location")).toBe("/admin/llm");
    expect(await waiting()).toBe(1);
    expect(await (await instance.get("/admin/llm", { cookie })).text()).toContain("1 message waits to be read.");
  });

  it("re-reads the messages of one Source from its page", async () => {
    const page = await (await instance.get(`/admin/sources/${mailbox}`, { cookie })).text();
    expect(page).toContain(`action="/admin/sources/${mailbox}/reread"`);

    const reread = await instance.post(`/admin/sources/${mailbox}/reread`, {}, { cookie });

    expect(reread.status).toBe(303);
    expect(reread.headers.get("location")).toBe(`/admin/sources/${mailbox}`);
    expect(await waiting()).toBe(1);
    expect(await (await instance.get(`/admin/sources/${mailbox}`, { cookie })).text()).toContain("1 message waits to be read.");
  });

  it("offers no re-reading for a Source that brings no messages", async () => {
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://example.org/cal.ics" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");

    expect(await (await instance.get(`/admin/sources/${added.id}`, { cookie })).text()).not.toContain("/reread");
  });

  it("keeps re-reading to signed-in Admins", async () => {
    expect((await instance.post("/admin/llm/reread", {})).headers.get("location")).toBe("/admin/sign-in");
    expect((await instance.post(`/admin/sources/${mailbox}/reread`, {})).headers.get("location")).toBe("/admin/sign-in");
    expect(await waiting()).toBe(0);
  });
});
