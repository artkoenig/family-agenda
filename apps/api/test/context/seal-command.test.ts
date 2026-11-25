import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openContext } from "../../src/context/context";
import { sealContextCommand } from "../../src/context/seal-command";

const key = "a-context-key-of-at-least-32-characters";
const described = {
  familyId: "0b8f3c1e-5d7a-4c2b-9e6f-1a2b3c4d5e6f",
  databaseUrl: "postgres://family:password@db/family_a",
  familyKey: randomBytes(32).toString("base64url"),
  blobDirectory: "/blobs",
  timeZone: "America/New_York",
  publicUrl: "https://b.example.org",
};

describe("family-agenda seal-context", () => {
  it("seals the Context described on standard input, for 5 minutes by default", () => {
    const sealed = sealContextCommand(key, JSON.stringify(described), 1_000);
    expect(openContext(key, sealed, 1_000)).toEqual({ ...described, expiresAt: 301_000 });
    expect(openContext(key, sealContextCommand(key, JSON.stringify({ ...described, ttlSeconds: 10 }), 0), 40_000)).toBeNull();
  });

  it("seals the Family's organization when it is described", () => {
    expect(openContext(key, sealContextCommand(key, JSON.stringify({ ...described, organizationId: "org-1" }), 1_000), 1_000)).toEqual({ ...described, organizationId: "org-1", expiresAt: 301_000 });
  });

  it("seals the platform's sections when they are described, and refuses ones the core would not take", () => {
    const sections = [{ id: "help", label: { en: "Help", de: "Hilfe" }, src: { en: "https://b.example.org/help", de: "https://b.example.org/hilfe" } }];
    expect(openContext(key, sealContextCommand(key, JSON.stringify({ ...described, sections }), 1_000), 1_000)).toEqual({ ...described, sections, expiresAt: 301_000 });
    expect(() => sealContextCommand(key, JSON.stringify({ ...described, sections: [{ ...sections[0], id: "" }] }), 0)).toThrow(/sections must be/);
  });

  it("refuses what the core would not open", () => {
    expect(() => sealContextCommand("", JSON.stringify(described), 0)).toThrow(/CONTEXT_KEY/);
    expect(() => sealContextCommand(key, "no json", 0)).toThrow(/Expected JSON/);
    expect(() => sealContextCommand(key, JSON.stringify({ ...described, ttlSeconds: 0 }), 0)).toThrow(/Expected JSON/);
    expect(() => sealContextCommand(key, JSON.stringify({ ...described, ttlSeconds: 86_401 }), 0)).toThrow(/Expected JSON/);
    expect(() => sealContextCommand(key, JSON.stringify({ ...described, familyKey: "short" }), 0)).toThrow(/32 bytes/);
    expect(() => sealContextCommand(key, JSON.stringify({ ...described, organizationId: "" }), 0)).toThrow(/organizationId, if given, not empty/);
    expect(() => sealContextCommand(key, JSON.stringify({ ...described, timeZone: "Nowhere" }), 0)).toThrow(/timeZone must be an IANA time zone/);
    expect(() => sealContextCommand(key, JSON.stringify({ ...described, identityProvider: { issuerUrl: "https://id.example.org", clientId: "x", clientSecret: "y" } }), 0)).toThrow(/identityProvider must not be set/);
  });
});
