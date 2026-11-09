import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { ScriptedExtractor } from "../support/scripted-extractor";

const password = "correct horse battery";

describe("choosing the model on the AI page", () => {
  let instance: HttpTestInstance;
  let extractor: ScriptedExtractor;
  let cookie: string;
  beforeEach(async () => {
    extractor = new ScriptedExtractor();
    instance = await bootHttpForTest({}, { extractor });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
  });
  afterEach(async () => {
    await instance.close();
  });

  const page = async () => (await instance.get("/admin/llm", { cookie })).text();

  it("asks for the model as text until the endpoint is saved", async () => {
    extractor.offerModels("gemma3");

    expect(await page()).toContain('<input id="model"');
  });

  it("offers the models of the endpoint, the saved one selected", async () => {
    extractor.offerModels("gemma3", "qwen3.5:9b");
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });

    const html = await page();

    expect(html).toContain('<select id="model"');
    expect(html).toContain('<option value="gemma3">');
    expect(html).toContain('<option value="qwen3.5:9b" selected="">');
  });

  it("keeps a saved model the endpoint no longer lists", async () => {
    extractor.offerModels("gemma3");
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "retired", apiKey: "" });

    expect(await page()).toContain('<option value="retired" selected="">');
  });

  it("asks for the model as text when the endpoint lists none", async () => {
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });

    expect(await page()).toContain('<input id="model"');
  });

  it("loads the models of a URL as it is entered, keeping what was typed as model", async () => {
    extractor.offerModels("gemma3");

    const response = await instance.post("/admin/llm/models", { baseUrl: "http://ollama:11434/v1", apiKey: "", model: "mine" }, { cookie });
    const html = await response.text();

    expect(html).toContain('id="model-field"');
    expect(html).toContain('<option value="mine" selected="">');
    expect(html).toContain('<option value="gemma3">');
  });

  it("asks the page to load models while the URL is typed, the model field disabled meanwhile", async () => {
    const html = await page();

    expect(html).toContain('hx-post="/admin/llm/models"');
    expect(html).toContain('hx-disabled-elt="#model"');
  });

  it("switches the AI off, forgetting the endpoint and its API key", async () => {
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "gemma3", apiKey: "secret" });
    expect(await page()).toContain('action="/admin/llm/remove"');

    const response = await instance.post("/admin/llm/remove", {}, { cookie });

    expect(response.status).toBe(303);
    expect(await instance.app.llmEndpoint.current()).toBeNull();
    expect(await page()).not.toContain('action="/admin/llm/remove"');
  });
});
