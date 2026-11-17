import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemorySecretStore } from "../support/in-memory-secret-store";
import { ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls } from "../support/test-source-plugin";

const supplied = { baseUrl: "https://llm.operator.example/v1", model: "operator-model", apiKey: "sk-operator" };

describe("an LLM endpoint the operator supplies", () => {
  let instance: TestInstance;
  let extractor: ScriptedExtractor;
  beforeEach(async () => {
    extractor = new ScriptedExtractor();
    instance = await bootForTest({ secretStore: new InMemorySecretStore(), extractor, suppliedLlmEndpoint: supplied });
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The endpoint the Extractor is given for a new message. */
  const extractedWith = async () => {
    await instance.installPlugin({ sourceTypeId: "mailbox", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: {} });
    testPluginControls.emit("mailbox", [
      { externalId: "m1", occurredAt: new Date("2026-09-14T06:00:00Z"), attributes: ["main"], content: { kind: "raw-message", text: "Hallo", attachments: [] } },
    ]);
    instance.clock.advance(15 * 60 * 1000);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
    return extractor.requests.at(-1)?.endpoint;
  };

  it("extracts through it, without a saved endpoint or an acknowledgement", async () => {
    expect(await extractedWith()).toEqual(supplied);
  });

  it("is used even where the Family saved one of its own", async () => {
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "gemma3", apiKey: "" });

    expect(await extractedWith()).toEqual(supplied);
  });

  it("is what the Family's endpoint is said to be, and is checked", async () => {
    extractor.offerModels("operator-model");

    expect(instance.app.llmEndpoint.supplied).toBe(true);
    expect(await instance.app.llmEndpoint.current()).toEqual({ baseUrl: supplied.baseUrl, model: supplied.model, hasApiKey: true, local: false });
    expect(await instance.app.llmEndpoint.check()).toEqual({ ok: true, models: ["operator-model"] });
  });
});
