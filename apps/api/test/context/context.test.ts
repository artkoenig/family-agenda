import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FamilyId } from "@family-agenda/adapters";
import { contextHeader, contextOfRequest, expirySkewMs, maximumContextLifetimeMs, openContext, sealContext, type Context } from "../../src/context/context";

const key = "a-context-key-of-at-least-32-characters";
const context: Context = {
  familyId: "0b8f3c1e-5d7a-4c2b-9e6f-1a2b3c4d5e6f" as FamilyId,
  databaseUrl: "postgres://family:password@db:5432/family_a",
  familyKey: randomBytes(32).toString("base64url"),
  blobDirectory: "/var/lib/family-agenda/blobs",
  expiresAt: 2_000,
};

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

  it("is refused when the sealed text is no Context", () => {
    expect(openContext(key, sealContext(key, { hello: "world" } as unknown as Context), 0)).toBeNull();
  });

  it("is read from its header only", () => {
    const sealed = sealContext(key, context);
    expect(contextOfRequest(key, new Request("http://core/", { headers: { [contextHeader]: sealed } }), 0)).toEqual(context);
    expect(contextOfRequest(key, new Request(`http://core/?context=${sealed}`), 0)).toBeNull();
    expect(contextOfRequest(key, new Request("http://core/", { headers: { cookie: `context=${sealed}` } }), 0)).toBeNull();
  });
});
