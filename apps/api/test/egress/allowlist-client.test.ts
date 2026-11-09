import { describe, expect, it } from "vitest";
import { allowlistFetcher, proxySettingsOf } from "../../src/egress/allowlist-client";

describe("allowlistFetcher", () => {
  it("fetches the hosts with the proxy's token", async () => {
    let seen: RequestInit | undefined;
    const fetchFn: typeof fetch = (_url, init) => {
      seen = init;
      return Promise.resolve(Response.json({ hosts: ["a.example:443"] }));
    };
    expect(await allowlistFetcher("http://api:3001/egress/plugin-x", "secret", fetchFn)()).toEqual(["a.example:443"]);
    expect(seen?.headers).toEqual({ authorization: "Bearer secret" });
  });

  it.each([
    ["a refusal", () => new Response("no", { status: 403 })],
    ["no list", () => Response.json({ hosts: "a.example" })],
    ["a list of non-strings", () => Response.json({ hosts: [1] })],
  ])("rejects %s", async (_, answer) => {
    await expect(allowlistFetcher("u", "t", () => Promise.resolve(answer()))()).rejects.toThrow();
  });
});

describe("proxySettingsOf", () => {
  it("reads the settings, with the default port", () => {
    expect(proxySettingsOf({ EGRESS_ALLOWLIST_URL: "u", EGRESS_TOKEN: "t" })).toEqual({ url: "u", token: "t", port: 3128 });
    expect(proxySettingsOf({ EGRESS_ALLOWLIST_URL: "u", EGRESS_TOKEN: "t", PORT: "9" }).port).toBe(9);
  });

  it("requires the url and the token", () => {
    expect(() => proxySettingsOf({ EGRESS_TOKEN: "t" })).toThrow(/EGRESS_ALLOWLIST_URL/);
    expect(() => proxySettingsOf({ EGRESS_ALLOWLIST_URL: "u" })).toThrow(/EGRESS_TOKEN/);
  });
});
