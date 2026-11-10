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
  const status = async () => (await instance.get("/admin/llm/status", { cookie })).text();
  const test = async (form: Record<string, string>) => (await instance.post("/admin/llm/test", form, { cookie })).text();
  const save = () => instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });

  it("asks for the model as text until the endpoint is saved or tested, saying so", async () => {
    extractor.offerModels("gemma3");
    const html = await page();

    expect(html).toContain('<input id="model"');
    expect(html).toContain("Test the connection to choose from the models of the endpoint.");
    expect(html).not.toContain('hx-get="/admin/llm/status"');
  });

  it("renders at once, loading the status and models of the saved endpoint as a fragment", async () => {
    extractor.offerModels("gemma3", "qwen3.5:9b");
    await save();

    const html = await page();

    expect(extractor.modelRequests, "the page does not wait on the endpoint").toEqual([]);
    expect(html).toContain('hx-get="/admin/llm/status?model=qwen3.5%3A9b"');
    expect(html).toContain('id="llm-status"');
  });

  it("offers the models of the saved endpoint in the fragment, the saved one selected, with its status", async () => {
    extractor.offerModels("gemma3", "qwen3.5:9b");
    await save();

    const html = await status();

    expect(html).toContain('<select id="model"');
    expect(html).toContain('<option value="gemma3">');
    expect(html).toContain('<option value="qwen3.5:9b" selected="">');
    expect(html).toContain('id="llm-status" hx-swap-oob="true"');
    expect(html).toContain("fam-chip--ok");
  });

  it("asks the endpoint once for status and models, and keeps the answer a while", async () => {
    extractor.offerModels("gemma3");
    await save();

    await status();
    await instance.get("/admin/llm/nav-status", { cookie });
    await status();

    expect(extractor.modelRequests).toHaveLength(1);
  });

  it("keeps a saved model the endpoint no longer lists", async () => {
    extractor.offerModels("gemma3");
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "retired", apiKey: "" });

    expect(await status()).toContain('<option value="retired" selected="">');
  });

  it("says why it asks for the model as text when the endpoint lists none", async () => {
    await save();

    const html = await status();

    expect(html).toContain('<input id="model"');
    expect(html).toContain("The endpoint lists no models; enter the name of one.");
  });

  it("explains a failing endpoint, and why it lists no models", async () => {
    extractor.failHealth("The LLM endpoint refused the API key (HTTP 401).");
    await save();

    const html = await status();

    expect(html).toContain("fam-banner--problem");
    expect(html).toContain("The LLM endpoint refused the API key (HTTP 401).");
    expect(html).toContain("fam-chip--problem");
    expect(html).toContain("The models could not be loaded");
  });

  it("answers no status fragment without a saved endpoint", async () => {
    expect((await instance.get("/admin/llm/status", { cookie })).status).toBe(404);
  });

  it("does not ask the endpoint while the URL is typed, but offers to test the connection", async () => {
    const html = await page();

    expect(html).not.toContain("hx-trigger=\"input");
    expect(html).toContain('hx-post="/admin/llm/test"');
    expect(html).toContain("Test connection");
    expect(html).toContain('hx-include="#baseUrl, #apiKey, #model"');
  });

  it("tests the entered URL and key, filling the models and keeping what was typed as model", async () => {
    extractor.offerModels("gemma3");

    const html = await test({ baseUrl: "http://ollama:11434/v1", apiKey: "sk-typed", model: "mine" });

    expect(extractor.modelRequests[0]).toMatchObject({ baseUrl: "http://ollama:11434/v1", apiKey: "sk-typed" });
    expect(html).toContain('id="model-field"');
    expect(html).toContain('<option value="mine" selected="">');
    expect(html).toContain('<option value="gemma3">');
    expect(html).toContain("Connected: the endpoint lists 1 model.");
  });

  it("explains why a test failed", async () => {
    extractor.failHealth("The LLM endpoint could not be reached: ECONNREFUSED");

    const html = await test({ baseUrl: "http://ollama:11434/v1", apiKey: "", model: "mine" });

    expect(html).toContain("fam-banner--problem");
    expect(html).toContain("The LLM endpoint could not be reached: ECONNREFUSED");
    expect(html).toContain('<input id="model" name="model" required="" value="mine"');
  });

  it("explains a URL that is none", async () => {
    const html = await test({ baseUrl: "not a url", apiKey: "", model: "" });

    expect(html).toContain("fam-banner--problem");
    expect(extractor.modelRequests).toEqual([]);
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
