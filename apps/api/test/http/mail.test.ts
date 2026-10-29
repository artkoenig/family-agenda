import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, extractedTask, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls } from "../support/test-source-plugin";

const password = "correct horse battery";

describe("the LLM endpoint and mail over HTTP", () => {
  let instance: HttpTestInstance;
  let extractor: ScriptedExtractor;
  let cookie: string;
  beforeEach(async () => {
    extractor = new ScriptedExtractor();
    instance = await bootHttpForTest(
      {},
      { extractor, blobStore: new InMemoryBlobStore(), sourcePlugins: [{ sourceTypeId: "school-mail", needsLlm: true }] },
    );
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
  });
  afterEach(async () => {
    await instance.close();
  });

  const settings = async () => (await instance.get("/admin/llm", { cookie })).text();

  it("saves a local endpoint", async () => {
    expect(await settings()).toMatch(/<input[^>]*name="baseUrl"/);

    const saved = await instance.post(
      "/admin/llm",
      { baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" },
      { cookie },
    );

    expect(saved.status).toBe(303);
    const page = await settings();
    expect(page).toContain('value="http://ollama:11434/v1"');
    expect(page).toContain("on your home network");
    expect(page).toMatch(/<input type="checkbox" name="vision" value="yes"\/>/);
  });

  it("saves that the model reads images", async () => {
    await instance.post("/admin/llm", { baseUrl: "http://ollama:11434/v1", model: "qwen3.5-vl:8b", apiKey: "", vision: "yes" }, { cookie });

    expect(await settings()).toMatch(/<input type="checkbox" name="vision" value="yes" checked=""\/>/);
    expect(await instance.app.llmEndpoint.current()).toMatchObject({ vision: true });
  });

  it("saves an endpoint outside the home network only with the acknowledgement, and never shows its key", async () => {
    const endpoint = { baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", apiKey: "sk-very-secret" };

    const refused = await instance.post("/admin/llm", endpoint, { cookie });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Confirm that the text of third parties");

    const saved = await instance.post("/admin/llm", { ...endpoint, thirdPartiesAcknowledged: "yes" }, { cookie });
    expect(saved.status).toBe(303);
    const page = await settings();
    expect(page).not.toContain("sk-very-secret");
    expect(page).toContain("Stored; leave empty to keep it");
  });

  it("keeps the LLM settings and raw messages to signed-in Admins", async () => {
    expect((await instance.get("/admin/llm")).headers.get("location")).toBe("/admin/sign-in");
    expect((await instance.post("/admin/llm", { baseUrl: "http://x/v1", model: "m" })).headers.get("location")).toBe(
      "/admin/sign-in",
    );
    expect((await instance.get("/admin/messages/00000000-0000-0000-0000-000000000000")).headers.get("location")).toBe(
      "/admin/sign-in",
    );
  });

  it("links an Event from a mail to the mail, which Admins can open", async () => {
    await instance.app.sourceTypes.enable("school-mail");
    await instance.app.sources.add({ sourceTypeId: "school-mail", plain: { url: "imap.example.org" }, secrets: {} });
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const created = await instance.app.views.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    const text = "Subject: Wandertag\n\nMorgen ist Wandertag, Treffpunkt 8 Uhr <am Bahnhof>.";
    extractor.script("Wandertag", [
      extracted({ title: "Wandertag", date: { daysAfter: 1 }, startTime: "08:00", evidence: "Morgen ist Wandertag, Treffpunkt 8 Uhr" }),
    ]);
    testPluginControls.emit("school-mail", [
      {
        externalId: "m1",
        occurredAt: new Date("2026-09-14T06:00:00Z"),
        attributes: { sender: "lehrerin@schule.example.org" },
        content: { kind: "raw-message", text, attachments: [{ filename: "plan.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) }] },
      },
    ]);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();

    const view = await (await instance.get(`/views/${created.id}`)).text();
    const link = /<a href="(\/admin\/messages\/[0-9a-f-]+)"/.exec(view)?.[1];
    expect(link).toBeDefined();

    const message = await (await instance.get(link!, { cookie })).text();
    expect(message).toContain("Morgen ist Wandertag, Treffpunkt 8 Uhr &lt;am Bahnhof&gt;.");
    expect(message).toContain("lehrerin@schule.example.org");
    expect(message).toContain("plan.pdf");
    expect(message).toContain("Could not be read for extraction:");
    expect(message).toContain("Monday, 14 September 2026 at 08:00");

    await instance.app.languages.setLanguage("de");
    expect(await (await instance.get(link!, { cookie })).text()).toContain("Montag, 14. September 2026 um 08:00");
  });

  it("links a Task from a mail to the mail", async () => {
    await instance.app.sourceTypes.enable("school-mail");
    await instance.app.sources.add({ sourceTypeId: "school-mail", plain: { url: "imap.example.org" }, secrets: {} });
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const created = await instance.app.views.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    extractor.script("Naturauftrag", [], [extractedTask({ title: "Naturauftrag", evidence: "Bringt drei Blätter mit" })]);
    testPluginControls.emit("school-mail", [
      {
        externalId: "m1",
        occurredAt: new Date("2026-09-14T06:00:00Z"),
        attributes: {},
        content: { kind: "raw-message", text: "Subject: Naturauftrag\n\nBringt drei Blätter mit.", attachments: [] },
      },
    ]);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();

    const view = await (await instance.get(`/views/${created.id}`)).text();
    const row = /<li class="fam-task[^"]*"(?:(?!<\/li>).)*Naturauftrag(?:(?!<\/li>).)*<\/li>/s.exec(view)?.[0] ?? "";
    expect(row).toMatch(/<a href="\/admin\/messages\/[0-9a-f-]+">Open the message<\/a>/);
  });
});
