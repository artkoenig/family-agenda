import { describe, expect, it } from "vitest";
import { allows, parseEntry } from "../../src/egress/allowlist";

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
