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
};

describe("family-agenda seal-context", () => {
  it("seals the Context described on standard input, for 5 minutes by default", () => {
    const sealed = sealContextCommand(key, JSON.stringify(described), 1_000);
    expect(openContext(key, sealed, 1_000)).toEqual({ ...described, expiresAt: 301_000 });
    expect(openContext(key, sealContextCommand(key, JSON.stringify({ ...described, ttlSeconds: 10 }), 0), 10_000)).toBeNull();
  });

  it("refuses what the core would not open", () => {
    expect(() => sealContextCommand("", JSON.stringify(described), 0)).toThrow(/CONTEXT_KEY/);
    expect(() => sealContextCommand(key, "no json", 0)).toThrow(/Expected JSON/);
    expect(() => sealContextCommand(key, JSON.stringify({ ...described, ttlSeconds: 0 }), 0)).toThrow(/Expected JSON/);
    expect(() => sealContextCommand(key, JSON.stringify({ ...described, familyKey: "short" }), 0)).toThrow(/32 bytes/);
  });
});
