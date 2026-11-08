import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeClient } from "../src/homeserver";

describe("the bridge's login steps", () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "user_input", step_id: "fi.mau.whatsapp.phone" }));
  });
  let url: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it("are other steps, with their type as instructions, when they are neither a code nor complete", async () => {
    const bridge = bridgeClient({ url, secret: "s", timeoutMs: 1000 });

    expect(await bridge.startLogin("@u:x", "qr")).toEqual({ type: "other", loginId: "", instructions: "user_input" });
    expect(await bridge.waitForStep("@u:x", { loginId: "l1", stepId: "s1" })).toEqual({ type: "other", loginId: "l1", instructions: "user_input" });
  });
});
