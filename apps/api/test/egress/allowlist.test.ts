import type { SourceTypeId } from "@family-agenda/domain";
import { describe, expect, it } from "vitest";
import { allowlistOf, allows, parseEgressTokens, parseEntry, parsePluginEgress, type AllowlistSources } from "../../src/egress/allowlist";
import { createAllowlistApp } from "../../src/egress/allowlist-server";

describe("parsePluginEgress", () => {
  it("reads the hosts per container", () => {
    expect(parsePluginEgress(" plugin-demo=api.example.com:443;*.example.org:443 , plugin-demo-x=a.example:80,plugin-demo-x=b.example:80")).toEqual(
      new Map([
        ["plugin-demo", ["api.example.com:443", "*.example.org:443"]],
        ["plugin-demo-x", ["a.example:80", "b.example:80"]],
      ]),
    );
    expect(parsePluginEgress(undefined)).toEqual(new Map());
    expect(parsePluginEgress("")).toEqual(new Map());
  });

  it("rejects an entry without a container", () => {
    expect(() => parsePluginEgress("api.example.com:443")).toThrow(/PLUGIN_EGRESS/);
    expect(() => parsePluginEgress("=api.example.com:443")).toThrow(/PLUGIN_EGRESS/);
  });
});

describe("parseEgressTokens", () => {
  it("reads the token per container and skips empty ones", () => {
    expect(parseEgressTokens("plugin-demo=abc,plugin-x=")).toEqual(new Map([["plugin-demo", "abc"]]));
    expect(parseEgressTokens(undefined)).toEqual(new Map());
    expect(() => parseEgressTokens("abc")).toThrow(/PLUGIN_EGRESS_TOKENS/);
  });
});

const sources: AllowlistSources = {
  declared: new Map([
    ["plugin-imap", ["login.example.com:443"]],
    ["plugin-imap-helper", ["helper.example.com:443"]],
  ]),
  bindings: [{ sourceTypeId: "imap" as SourceTypeId, url: "http://somewhere-else:8080" }],
  hostsOf: (id) =>
    Promise.resolve(
      id === "imap"
        ? ["IMAP.gmx.net", "login.example.com:443", "*", "*.example.org", "https://evil.example/", "a.example/path", "b.example:0", "c.example:70000", "mail.example:993"]
        : ["unexpected"],
    ),
};

describe("allowlistOf", () => {
  it("adds the valid hosts of a plugin's Sources to its own container's declared ones", async () => {
    expect(await allowlistOf("plugin-imap", sources)).toEqual(["login.example.com:443", "imap.gmx.net", "mail.example:993"]);
  });

  it("gives a companion only its declared hosts", async () => {
    expect(await allowlistOf("plugin-imap-helper", sources)).toEqual(["helper.example.com:443"]);
  });

  it("gives an unknown container nothing", async () => {
    expect(await allowlistOf("plugin-other", sources)).toEqual([]);
  });
});

describe("the allowlist server", () => {
  const app = createAllowlistApp(sources, new Map([["plugin-imap", "token-imap"], ["plugin-imap-helper", "token-helper"]]));
  const get = (service: string, token?: string) =>
    app.request(`/egress/${service}`, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });

  it("serves a proxy its own container's allowlist", async () => {
    const response = await get("plugin-imap", "token-imap");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hosts: ["login.example.com:443", "imap.gmx.net", "mail.example:993"] });
  });

  it.each([
    ["no token", "plugin-imap", undefined],
    ["a wrong token", "plugin-imap", "nope"],
    ["another proxy's token", "plugin-imap", "token-helper"],
    ["a container without a token", "plugin-other", "token-imap"],
  ])("refuses %s", async (_, service, token) => {
    expect((await get(service, token)).status).toBe(403);
  });
});

describe("parseEntry", () => {
  it.each([
    ["api.example.com:443", { name: "api.example.com", wildcard: false, port: 443 }],
    ["IMAP.gmx.net", { name: "imap.gmx.net", wildcard: false, port: null }],
    ["*.example.org:443", { name: "example.org", wildcard: true, port: 443 }],
    ["*", null],
    ["*.", null],
    ["https://example.org", null],
    ["example.org/path", null],
    ["example.org:0", null],
    ["example.org:65536", null],
    ["-bad.example", null],
    ["", null],
  ])("%s", (text, entry) => {
    expect(parseEntry(text)).toEqual(entry);
  });
});

describe("allows", () => {
  const entries = ["api.example.com:443", "*.example.org:443", "imap.gmx.net"].flatMap((text) => parseEntry(text) ?? []);

  it.each([
    ["api.example.com", 443, true],
    ["API.Example.com", 443, true],
    ["api.example.com", 80, false],
    ["evil-api.example.com", 443, false],
    ["a.example.org", 443, true],
    ["a.b.example.org", 443, true],
    ["example.org", 443, false],
    ["badexample.org", 443, false],
    ["imap.gmx.net", 993, true],
    ["imap.gmx.net", 143, true],
    ["smtp.gmx.net", 993, false],
  ])("%s:%i → %s", (host, port, allowed) => {
    expect(allows(entries, { host, port })).toBe(allowed);
  });

  it("allows nothing with an empty list", () => {
    expect(allows([], { host: "api.example.com", port: 443 })).toBe(false);
  });
});
