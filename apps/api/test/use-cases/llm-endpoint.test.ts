import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemorySecretStore } from "../support/in-memory-secret-store";
import { ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";

describe("the LLM endpoint", () => {
  let instance: TestInstance;
  let secrets: InMemorySecretStore;
  let extractor: ScriptedExtractor;
  let mails: number;
  beforeEach(async () => {
    secrets = new InMemorySecretStore();
    extractor = new ScriptedExtractor();
    instance = await bootForTest({ secretStore: secrets, extractor });
    mails = 0;
  });
  afterEach(async () => {
    await instance.close();
  });

  it("is not configured at first", async () => {
    expect(await instance.app.llmEndpoint.current()).toBeNull();
  });

  it("saves a local server without an API key or acknowledgement", async () => {
    const saved = await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1/", model: "qwen3.5:9b", apiKey: "" });

    expect(saved).toEqual({ ok: true });
    expect(await instance.app.llmEndpoint.current()).toEqual({
      baseUrl: "http://ollama:11434/v1",
      model: "qwen3.5:9b",
      hasApiKey: false,
      local: true,
    });
  });

  it("needs an acknowledgement that third parties' messages are sent to an endpoint outside the home network", async () => {
    const endpoint = { baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", apiKey: "sk-secret" };

    expect(await instance.app.llmEndpoint.save(endpoint)).toEqual({ ok: false, problem: "third-parties-not-acknowledged" });
    expect(await instance.app.llmEndpoint.current()).toBeNull();

    expect(await instance.app.llmEndpoint.save({ ...endpoint, thirdPartiesAcknowledged: true })).toEqual({ ok: true });
    expect(await instance.app.llmEndpoint.current()).toMatchObject({ hasApiKey: true, local: false });
  });

  it("keeps the API key in the SecretStore, and only hands it to the endpoint", async () => {
    await instance.app.llmEndpoint.save({
      baseUrl: "https://llm.example.org/v1",
      model: "large",
      apiKey: "sk-first",
      thirdPartiesAcknowledged: true,
    });
    const [stored] = await instance.query("SELECT * FROM llm_endpoints");
    expect(JSON.stringify(stored)).not.toContain("sk-first");

    // Left empty, the stored key stays; a new one replaces it.
    await instance.app.llmEndpoint.save({ baseUrl: "https://llm.example.org/v1", model: "larger", apiKey: "", thirdPartiesAcknowledged: true });
    expect(await extractedWithKey()).toBe("sk-first");
    await instance.app.llmEndpoint.save({ baseUrl: "https://llm.example.org/v1", model: "larger", apiKey: "sk-second", thirdPartiesAcknowledged: true });
    expect(await extractedWithKey()).toBe("sk-second");
    expect(secrets.size).toBe(1);

    await instance.app.llmEndpoint.save({ baseUrl: "http://localhost:8080/v1", model: "local", apiKey: "", removeApiKey: true });
    expect(await instance.app.llmEndpoint.current()).toMatchObject({ hasApiKey: false });
    expect(secrets.size).toBe(0);
  });

  it("refuses an address that is no http or https URL, and an empty model", async () => {
    for (const baseUrl of ["ollama:11434", "ftp://llm.example.org", "http://user:pw@llm.example.org/v1", ""]) {
      expect(await instance.app.llmEndpoint.save({ baseUrl, model: "m", apiKey: "" })).toEqual({
        ok: false,
        problem: "invalid-endpoint-url",
      });
    }
    expect(await instance.app.llmEndpoint.save({ baseUrl: "http://localhost:11434/v1", model: " ", apiKey: "" })).toEqual({
      ok: false,
      problem: "invalid-model",
    });
  });

  /** The API key the Extractor is given for the next message. */
  const extractedWithKey = async () => {
    if (mails === 0) {
      await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "mailbox", needsLlm: true });
      await instance.restart();
      await instance.app.sourceTypes.enable("mailbox");
      await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: {} });
    }
    mails += 1;
    testPluginControls.emit("mailbox", [
      {
        externalId: `m${mails}`,
        occurredAt: new Date("2026-09-14T06:00:00Z"),
        attributes: {},
        content: { kind: "raw-message", text: "Hallo", attachments: [] },
      },
    ]);
    instance.clock.advance(15 * 60 * 1000);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
    return extractor.requests.at(-1)?.endpoint.apiKey;
  };
});
