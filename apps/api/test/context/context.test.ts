import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FamilyId } from "@family-agenda/adapters";
import { contextHeader, contextOfRequest, expirySkewMs, maximumContextLifetimeMs, openContext, openContextOutcome, sealContext, type Context } from "../../src/context/context";

const key = "a-context-key-of-at-least-32-characters";
const context: Context = {
  familyId: "0b8f3c1e-5d7a-4c2b-9e6f-1a2b3c4d5e6f" as FamilyId,
  databaseUrl: "postgres://family:password@db:5432/family_a",
  familyKey: randomBytes(32).toString("base64url"),
  blobDirectory: "/var/lib/family-agenda/blobs",
  timeZone: "Europe/Berlin",
  publicUrl: "https://a.example.org/agenda",
  expiresAt: 2_000,
};
const identityProvider = { issuerUrl: "https://id.example.org", clientId: "family-agenda", clientSecret: "s3cret-of-a" };

describe("a Context", () => {
  it("opens with the key it was sealed with until it expires, after a little skew", () => {
    const sealed = sealContext(key, context);
    expect(openContext(key, sealed, 1_999)).toEqual(context);
    expect(openContext(key, sealed, 2_000 + expirySkewMs - 1)).toEqual(context);
    expect(openContext(key, sealed, 2_000 + expirySkewMs)).toBeNull();
  });

  it("is refused when it lasts longer than a day", () => {
    expect(openContext(key, sealContext(key, { ...context, expiresAt: 2_000 + maximumContextLifetimeMs }), 2_000)).toEqual({ ...context, expiresAt: 2_000 + maximumContextLifetimeMs });
    expect(openContext(key, sealContext(key, { ...context, expiresAt: 2_001 + maximumContextLifetimeMs }), 2_000)).toBeNull();
  });

  it("does not show what it carries", () => {
    const sealed = sealContext(key, context);
    expect(sealed).not.toContain("password");
    expect(Buffer.from(sealed.split(".")[2] ?? "", "base64url").toString()).not.toContain("family_a");
  });

  it("seals the same Context differently each time", () => {
    expect(sealContext(key, context)).not.toBe(sealContext(key, context));
  });

  it("is refused when sealed with another key", () => {
    expect(openContext("another-context-key-of-at-least-32-chars", sealContext(key, context), 0)).toBeNull();
  });

  it("is refused when altered anywhere", () => {
    const sealed = sealContext(key, context);
    for (let index = 0; index < sealed.length; index += 1) {
      if (sealed[index] === ".") continue;
      for (const replacement of ["A", "B"]) {
        if (sealed[index] === replacement) continue;
        expect(openContext(key, sealed.slice(0, index) + replacement + sealed.slice(index + 1), 0)).toBeNull();
      }
    }
  });

  it("is refused without a family key of 32 bytes or with a Family id that is no UUID", () => {
    expect(openContext(key, sealContext(key, { ...context, familyKey: randomBytes(16).toString("base64url") }), 0)).toBeNull();
    expect(openContext(key, sealContext(key, { ...context, familyId: "family-a" as FamilyId }), 0)).toBeNull();
  });

  it.each([[""], ["v1"], ["v1.a.b"], ["v1.a.b.c.d"], ["v2.a.b.c"], ["v1..."]])("is refused for %j", (text) => {
    expect(openContext(key, text, 0)).toBeNull();
  });

  it("is refused when a part is not written as its bytes are, so that no two texts open alike", () => {
    const [version, iv, ciphertext, tag] = sealContext(key, context).split(".");
    const parts = (changed: Record<number, string>) => [version, iv, ciphertext, tag].map((part, index) => changed[index] ?? part).join(".");
    expect(openContext(key, parts({}), 0)).toEqual(context);
    expect(openContext(key, parts({ 1: `${iv}A` }), 0)).toBeNull();
    expect(openContext(key, parts({ 2: `${ciphertext}A` }), 0)).toBeNull();
    expect(openContext(key, parts({ 3: `${tag}A` }), 0)).toBeNull();
  });

  it("is refused when the sealed text is no Context", () => {
    expect(openContext(key, sealContext(key, { hello: "world" } as unknown as Context), 0)).toBeNull();
  });

  it("is read from its header only", () => {
    const sealed = sealContext(key, context);
    expect(contextOfRequest(key, new Request("http://core/", { headers: { [contextHeader]: sealed } }), 0)).toEqual(context);
    expect(contextOfRequest(key, new Request(`http://core/?context=${sealed}`), 0)).toBeNull();
    expect(contextOfRequest(key, new Request("http://core/", { headers: { cookie: `context=${sealed}` } }), 0)).toBeNull();
  });

  it("carries the Family's time zone and public address, the latter without a trailing slash", () => {
    expect(openContext(key, sealContext(key, { ...context, publicUrl: "https://a.example.org/agenda/" }), 1_000)).toEqual(context);
  });

  it("carries the Family's organization when the caller names it, and none otherwise", () => {
    expect(openContext(key, sealContext(key, { ...context, organizationId: "org-1" }), 1_000)).toEqual({ ...context, organizationId: "org-1" });
    expect(openContext(key, sealContext(key, context), 1_000)).not.toHaveProperty("organizationId");
  });

  it("opens without a time zone, which the Family then starts with Europe/Berlin", () => {
    const withoutTimeZone = { ...context };
    delete withoutTimeZone.timeZone;
    const opened = openContext(key, sealContext(key, withoutTimeZone), 1_000);
    expect(opened).toEqual(withoutTimeZone);
    expect(opened).not.toHaveProperty("timeZone");
  });

  it("is refused with an empty organization", () => {
    expect(openContext(key, sealContext(key, { ...context, organizationId: "" }), 1_000)).toBeNull();
  });

  it.each<[string, Partial<Record<keyof Context | "identityProvider", unknown>>, RegExp]>([
    ["with a time zone that is none", { timeZone: "Mars/Olympus" }, /timeZone must be/],
    ["with an offset for a time zone", { timeZone: "+01:00" }, /timeZone must be/],
    ["without a public address", { publicUrl: undefined }, /publicUrl must be/],
    ["with a public address that is no http address", { publicUrl: "ftp://a.example.org" }, /publicUrl must be/],
    ["with a public address with a query", { publicUrl: "https://a.example.org/?x=1" }, /publicUrl must be/],
    ["with an Identity Provider, which comes from the environment", { identityProvider }, /identityProvider must not be set: .*OIDC_\* variables/],
    ["with an empty Identity Provider", { identityProvider: {} }, /identityProvider must not be set/],
  ])("is refused %s, naming what is wrong", (_, change, problem) => {
    const sealed = sealContext(key, { ...context, ...change } as Context);
    expect(openContext(key, sealed, 1_000)).toBeNull();
    const outcome = openContextOutcome(key, sealed, 1_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.problem).toMatch(problem);
    expect(outcome.ok ? "" : outcome.problem).not.toContain("s3cret");
  });

  describe("with sections of the platform", () => {
    const section = {
      id: "contract",
      label: { en: "Contract", de: "Vertrag" },
      src: { en: "https://a.example.org/platform/contract?lang=en", de: "https://a.example.org/platform/contract?lang=de" },
    };
    const openWith = (sections: unknown) => openContextOutcome(key, sealContext(key, { ...context, sections } as Context), 1_000);
    const numbered = (count: number) => Array.from({ length: count }, (_, index) => ({ ...section, id: `section-${index}` }));
    const addressOfLength = (length: number) => "https://a.example.org/".padEnd(length, "x");

    it("carries them as given, in their order, and none when it names none", () => {
      const sections = [{ ...section, onlyFor: "sub-anna" }, { ...section, id: "help-2" }];
      expect(openWith(sections)).toEqual({ ok: true, context: { ...context, sections } });
      expect(openWith([])).toEqual({ ok: true, context: { ...context, sections: [] } });
      expect(openContext(key, sealContext(key, context), 1_000)).not.toHaveProperty("sections");
    });

    it("takes them up to their limits", () => {
      expect(openWith(numbered(5)).ok).toBe(true);
      expect(openWith([{ ...section, id: "a".repeat(32) }]).ok).toBe(true);
      expect(openWith([{ ...section, label: { en: "x".repeat(60), de: "x".repeat(60) } }]).ok).toBe(true);
      expect(openWith([{ ...section, src: { ...section.src, de: addressOfLength(500) } }]).ok).toBe(true);
    });

    it.each([
      ["no list", { contract: "s3cret" }],
      ["more than 5", numbered(6)],
      ["an id that is no slug", [{ ...section, id: "s3cret Contract" }]],
      ["an empty id", [{ ...section, id: "" }]],
      ["an id of more than 32 characters", [{ ...section, id: "a".repeat(33) }]],
      ["an id twice", [section, section]],
      ["a label of more than 60 characters", [{ ...section, label: { ...section.label, de: "x".repeat(61) } }]],
      ["a blank label", [{ ...section, label: { ...section.label, en: " " } }]],
      ["a label missing a Family Language", [{ ...section, label: { en: "s3cret" } }]],
      ["an address missing a Family Language", [{ ...section, src: { de: section.src.de } }]],
      ["an address of more than 500 characters", [{ ...section, src: { ...section.src, en: addressOfLength(501) } }]],
      ["an http address", [{ ...section, src: { ...section.src, en: "http://a.example.org/s3cret" } }]],
      ["a path alone", [{ ...section, src: { ...section.src, en: "/s3cret" } }]],
      ["no address", [{ ...section, src: { ...section.src, en: "https://" } }]],
      ["an address with credentials", [{ ...section, src: { ...section.src, en: "https://anna:s3cret@a.example.org/" } }]],
      ["an address of another host", [{ ...section, src: { ...section.src, en: "https://platform.example.org/s3cret" } }]],
      ["an address of another port", [{ ...section, src: { ...section.src, en: "https://a.example.org:8443/s3cret" } }]],
      ["an empty onlyFor", [{ ...section, onlyFor: "" }]],
      ["a field it does not know", [{ ...section, href: "s3cret" }]],
    ])("is refused with %s, naming sections and no value", (_, sections) => {
      const outcome = openWith(sections);
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? "" : outcome.problem).toMatch(/^sections must be /);
      expect(outcome.ok ? "" : outcome.problem).not.toContain("s3cret");
    });

    it("is refused with them below an http publicUrl, as no https address is of its origin", () => {
      const outcome = openContextOutcome(key, sealContext(key, { ...context, publicUrl: "http://a.example.org", sections: [section] }), 1_000);
      expect(outcome.ok ? "" : outcome.problem).toMatch(/^sections must be /);
    });
  });

  it("names no problem of a Context that does not open", () => {
    expect(openContextOutcome(key, `${sealContext(key, { ...context, timeZone: "x" }).slice(0, -2)}AA`, 1_000)).toEqual({ ok: false, problem: null });
    expect(openContextOutcome("another-context-key-of-at-least-32-chars", sealContext(key, { ...context, timeZone: "x" }), 1_000)).toEqual({ ok: false, problem: null });
  });
});
