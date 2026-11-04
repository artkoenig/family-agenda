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
    expect(page).toContain("fam-chip--ok");
    expect(page).not.toContain('name="vision"');
  });

  it("shows the error in a red banner when the endpoint fails", async () => {
    await instance.post(
      "/admin/llm",
      { baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" },
      { cookie },
    );

    extractor.failHealth("connection refused");

    const page = await settings();
    expect(page).toContain("fam-banner--problem");
    expect(page).toContain("Connection error");
    expect(page).toContain("connection refused");
    expect(page).toContain("fam-chip--problem");
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
    expect(
      (await instance.get("/admin/messages/00000000-0000-0000-0000-000000000000/attachments/0")).headers.get("location"),
    ).toBe("/admin/sign-in");
    expect((await instance.post("/admin/items/00000000-0000-0000-0000-000000000000/delete", {})).headers.get("location")).toBe(
      "/admin/sign-in",
    );
  });

  it("lists a mail's Items next to it, where an Admin deletes a wrong one", async () => {
    await instance.app.sourceTypes.enable("school-mail");
    await instance.app.sources.add({ sourceTypeId: "school-mail", plain: { url: "imap.example.org" }, secrets: {} });
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    extractor.script("Wandertag", [
      extracted({ title: "Wandertag", date: { daysAfter: 1 }, startTime: "08:00", evidence: "Morgen ist Wandertag, Treffpunkt 8 Uhr" }),
    ]);
    testPluginControls.emit("school-mail", [
      { externalId: "m1", occurredAt: new Date("2026-09-14T06:00:00Z"), attributes: {}, content: { kind: "raw-message", text: "Morgen ist Wandertag, Treffpunkt 8 Uhr.", attachments: [] } },
    ]);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
    const link = /<a href="(\/admin\/messages\/[0-9a-f-]+)"/.exec(await (await instance.get(`/agendas/${created.id}`)).text())?.[1];

    const page = await (await instance.get(link!, { cookie })).text();
    const action = /<form method="post" action="(\/admin\/items\/[0-9a-f-]+\/delete)"/.exec(page)?.[1];
    expect(page).toContain("Wandertag");
    // As the Agenda shows an Event: under its day, as a row.
    expect(page).toContain('class="fam-day"');
    expect(page).toContain("fam-item__title");
    expect(action).toBeDefined();

    const deleted = await instance.post(action!, { message: link!.split("/")[3]! }, { cookie });

    expect(deleted.status).toBe(303);
    expect(deleted.headers.get("location")).toBe(link);
    expect(await (await instance.get(link!, { cookie })).text()).toContain("No Items were read from it.");
    expect(await (await instance.get(`/agendas/${created.id}`)).text()).not.toContain("Wandertag");
  });

  it("links an Event from a mail to the mail, which Admins can open", async () => {
    await instance.app.sourceTypes.enable("school-mail");
    await instance.app.sources.add({ sourceTypeId: "school-mail", plain: { url: "imap.example.org" }, secrets: {} });
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 3 });
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

    const agenda = await (await instance.get(`/agendas/${created.id}`)).text();
    const link = /<a href="(\/admin\/messages\/[0-9a-f-]+)"/.exec(agenda)?.[1];
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

  it("lets Admins download the attachments of a mail as the Source delivered them", async () => {
    await instance.app.sourceTypes.enable("school-mail");
    await instance.app.sources.add({ sourceTypeId: "school-mail", plain: { url: "imap.example.org" }, secrets: {} });
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    extractor.script("Elternabend", [extracted({ title: "Elternabend", date: { daysAfter: 1 }, evidence: "Morgen ist Elternabend" })]);
    testPluginControls.emit("school-mail", [
      {
        externalId: "m1",
        occurredAt: new Date("2026-09-14T06:00:00Z"),
        attributes: {},
        content: {
          kind: "raw-message",
          text: "Subject: Elternabend\n\nMorgen ist Elternabend.",
          attachments: [
            { filename: "Einladung.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) },
            { filename: "Übersicht \"(1)\".html", contentType: "text/html", bytes: new TextEncoder().encode("<script>alert(1)</script>") },
          ],
        },
      },
    ]);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
    const agenda = await (await instance.get(`/agendas/${created.id}`)).text();
    const link = /<a href="(\/admin\/messages\/[0-9a-f-]+)"/.exec(agenda)![1]!;

    const message = await (await instance.get(link, { cookie })).text();
    expect(message).toContain(`<a href="${link}/attachments/0" download="Einladung.pdf">Einladung.pdf</a>`);
    expect(message).toContain(`href="${link}/attachments/1"`);

    const pdf = await instance.get(`${link}/attachments/0`, { cookie });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe(
      `attachment; filename="Einladung.pdf"; filename*=UTF-8''Einladung.pdf`,
    );
    expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const html = await instance.get(`${link}/attachments/1`, { cookie });
    expect(html.headers.get("content-disposition")).toBe(
      `attachment; filename="_bersicht _(1)_.html"; filename*=UTF-8''%C3%9Cbersicht%20%22%281%29%22.html`,
    );
    expect(html.headers.get("content-security-policy")).toBe("sandbox");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");

    expect((await instance.get(`${link}/attachments/2`, { cookie })).status).toBe(404);
    expect((await instance.get("/admin/messages/00000000-0000-0000-0000-000000000000/attachments/0", { cookie })).status).toBe(404);
  });

  it("links a Task from a mail to the mail", async () => {
    await instance.app.sourceTypes.enable("school-mail");
    await instance.app.sources.add({ sourceTypeId: "school-mail", plain: { url: "imap.example.org" }, secrets: {} });
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 3 });
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

    const agenda = await (await instance.get(`/agendas/${created.id}`)).text();
    const row = /<li class="fam-item fam-task[^"]*"(?:(?!<\/li>).)*Naturauftrag(?:(?!<\/li>).)*<\/li>/s.exec(agenda)?.[0] ?? "";
    expect(row).toMatch(/<a href="\/admin\/messages\/[0-9a-f-]+">Open the message<\/a>/);
    expect(row).not.toContain("Admins only");
  });
});
