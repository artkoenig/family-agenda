import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { ScriptedExtractor } from "../support/scripted-extractor";

const password = "correct horse battery";

/** An endpoint whose check can be held, as a slow LLM server's. */
class HeldCheck extends ScriptedExtractor {
  held = false;
  asked = 0;
  override check(...args: Parameters<ScriptedExtractor["check"]>) {
    this.asked++;
    return this.held ? new Promise<never>(() => undefined) : super.check(...args);
  }
}

describe("The LLM status every Admin page shows", () => {
  let instance: HttpTestInstance;
  let extractor: HeldCheck;
  let cookie: string;
  beforeEach(async () => {
    extractor = new HeldCheck();
    instance = await bootHttpForTest({}, { extractor });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
  });
  afterEach(async () => {
    await instance.close();
  });

  const navStatus = async () => (await instance.get("/admin/llm/nav-status", { cookie })).text();

  it("loads as a fragment, so that no settings page waits on the endpoint", async () => {
    extractor.held = true;

    const page = await (await instance.get("/admin/agendas", { cookie })).text();

    expect(page).toContain('hx-get="/admin/llm/nav-status"');
    expect(page, "the model meanwhile").toContain("qwen3.5:9b");
    expect(extractor.asked).toBe(0);
  });

  it("shows the last answer while the endpoint is asked again in the background, so that a slow endpoint does not hold it", async () => {
    extractor.failHealth("down");
    expect(await navStatus()).toContain("Connection problem");

    instance.clock.advance(60_000);
    extractor.held = true;
    expect(await navStatus(), "the last answer, not waiting for the new one").toContain("Connection problem");
    await vi.waitFor(() => {
      expect(extractor.asked, "asked again in the background").toBe(2);
    });
  });

  it("shows the model while the endpoint answers", async () => {
    const html = await navStatus();

    expect(html).toContain("qwen3.5:9b");
    expect(html).not.toContain("--attention");
  });
});
