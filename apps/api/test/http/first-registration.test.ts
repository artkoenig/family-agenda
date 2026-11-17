import { afterEach, describe, expect, it } from "vitest";
import { bootHttpForTest, signedInCookie, type HttpTestInstance } from "../support/http";
import { InMemoryIdentityDirectory } from "../support/in-memory-identity-directory";

describe("a fixed Instance before its first registration (ADR-0010)", () => {
  let instance: HttpTestInstance;
  afterEach(async () => {
    await instance.close();
  });

  it("shows only the sign-in page until registration creates the Family, then the Admin area as before", async () => {
    instance = await bootHttpForTest({}, { idpWebhookSecret: "logto-signing-key", identityDirectoryClient: new InMemoryIdentityDirectory() });

    const cookie = await signedInCookie(instance);
    const before = await instance.get("/admin/family-members", { cookie });
    expect(before.status).toBe(302);
    expect(before.headers.get("location")).toBe("/admin/sign-in");
    expect((await instance.get("/admin/sign-in")).status).toBe(200);

    await instance.app.registration.register({ userId: "user-anna", email: "anna@example.org" });

    const after = await instance.get("/admin/family-members", { cookie });
    expect(after.headers.get("location")).not.toBe("/admin/sign-in");
  });
});
