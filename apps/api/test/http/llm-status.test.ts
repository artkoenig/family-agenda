import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { ScriptedExtractor } from "../support/scripted-extractor";

const password = "correct horse battery";

/** An endpoint whose health check can be held, as a slow LLM server's. */
class HeldHealth extends ScriptedExtractor {
  held = false;
  asked = 0;
  override health() {
    this.asked++;
    return this.held ? new Promise<never>(() => undefined) : super.health();
  }
}

describe("The LLM status every Admin page shows", () => {
  let instance: HttpTestInstance;
  let extractor: HeldHealth;
  let cookie: string;
  beforeEach(async () => {
    extractor = new HeldHealth();
    instance = await bootHttpForTest({}, { extractor });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
  });
  afterEach(async () => {
    await instance.close();
  });

  it("shows the last answer while the endpoint is asked again in the background, so that a slow endpoint does not hold the page", async () => {
    extractor.failHealth("down");
    expect(await (await instance.get("/admin/agendas", { cookie })).text()).toContain("Connection problem");

    instance.clock.advance(60_000);
    extractor.held = true;
    const page = await (await instance.get("/admin/agendas", { cookie })).text();
    expect(page, "the last answer, not waiting for the new one").toContain("Connection problem");
    expect(extractor.asked).toBe(2);
  });
});
