import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, type HttpTestInstance, signedInCookie } from "../support/http";
import { ScriptedExtractor } from "../support/scripted-extractor";

describe("the AI page with an LLM endpoint the operator supplies", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  beforeEach(async () => {
    instance = await bootHttpForTest({}, {
      extractor: new ScriptedExtractor(),
      suppliedLlmEndpoint: { baseUrl: "https://llm.operator.example/v1", model: "operator-model", apiKey: "sk-operator" },
    });
    await instance.app.recoveryKit.confirm();
    cookie = await signedInCookie(instance);
  });
  afterEach(async () => {
    await instance.close();
  });

  it("shows no connection, only the rest of the page", async () => {
    const response = await instance.get("/admin/llm", { cookie });
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page).not.toContain('name="baseUrl"');
    expect(page).not.toContain('name="thirdPartiesAcknowledged"');
    expect(page).not.toContain("/admin/llm/test");
    expect(page).not.toContain("/admin/llm/remove");
    expect(page).toContain("/admin/llm/ocr");
  });

  it("loads the supplied endpoint's status into the header, without a model field", async () => {
    const extractor = new ScriptedExtractor();
    extractor.offerModels("operator-model");
    await instance.close();
    instance = await bootHttpForTest({}, {
      extractor,
      suppliedLlmEndpoint: { baseUrl: "https://llm.operator.example/v1", model: "operator-model", apiKey: "sk-operator" },
    });
    await instance.app.recoveryKit.confirm();
    cookie = await signedInCookie(instance);

    const page = await (await instance.get("/admin/llm", { cookie })).text();
    const status = await (await instance.get("/admin/llm/status", { cookie })).text();

    expect(page).toContain('hx-get="/admin/llm/status"');
    expect(status).toContain('id="llm-status"');
    expect(status).toContain("fam-chip--ok");
    expect(status).not.toContain('id="model-field"');
  });

  it("refuses saving, testing and removing an endpoint", async () => {
    const form = { baseUrl: "http://ollama:11434/v1", model: "gemma3", apiKey: "" };
    expect((await instance.post("/admin/llm", form, { cookie })).status).toBe(404);
    expect((await instance.post("/admin/llm/test", form, { cookie })).status).toBe(404);
    expect((await instance.post("/admin/llm/remove", {}, { cookie })).status).toBe(404);
    expect(await instance.app.llmEndpoint.current()).toMatchObject({ model: "operator-model" });
  });
});

describe("the AI page without a supplied LLM endpoint", () => {
  it("shows the connection as before", async () => {
    const instance = await bootHttpForTest({}, { extractor: new ScriptedExtractor() });
    await instance.app.recoveryKit.confirm();
    const page = await (await instance.get("/admin/llm", { cookie: await signedInCookie(instance) })).text();
    await instance.close();

    expect(page).toContain('name="baseUrl"');
    expect(page).toContain('name="thirdPartiesAcknowledged"');
  });
});
