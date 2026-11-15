import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { parseIdentityProviderSettings } from "@family-agenda/application";
import { ScriptedIdentityProviderClient } from "../support/scripted-identity-provider";

const password = "correct horse battery";
const origin = "https://agenda.example.ts.net";
const settings = {
  issuerUrl: "https://id.example.ts.net",
  clientId: "family-agenda",
  clientSecret: "s3cret",
  requiredGroup: "homelab-admin",
  publicBaseUrl: origin,
};
const anna = {
  subject: "sub-anna",
  email: "anna@example.org",
  emailVerified: true,
  groups: ["homelab-admin"],
};

describe("Admins signing in through an Identity Provider", () => {
  let instance: TestInstance;
  let provider: ScriptedIdentityProviderClient;
  beforeEach(async () => {
    provider = new ScriptedIdentityProviderClient();
    instance = await bootForTest({
      identityProviderClient: provider,
      identityProvider: settings,
    });
    await instance.app.admins.createFirstAdmin({
      email: "anna@example.org",
      password,
    });
  });
  afterEach(async () => {
    await instance.close();
  });

  const sso = () => instance.app.singleSignOn;
  const signInAs = async (identity: typeof anna) => {
    const begun = await sso().begin(origin);
    if (!begun) throw new Error("sign-in not offered");
    return sso().complete({
      baseUrl: origin,
      query: provider.returnWith(begun.pending, identity),
      pending: begun.pending,
    });
  };

  describe("sign-in", () => {
    it("is offered only at the public base URL", async () => {
      expect(sso().isOfferedAt(origin)).toBe(true);
      expect(sso().isOfferedAt("http://family-agenda.local")).toBe(false);
      expect(await sso().begin("http://family-agenda.local")).toBeNull();
    });

    it("sends the Admin to the provider with the redirect URI and the stored secret", async () => {
      const begun = await sso().begin(origin);

      expect(begun?.authorizationUrl).toContain(
        "https://id.example.ts.net/authorize",
      );
      expect(provider.begun[0]).toEqual({
        connection: {
          issuerUrl: "https://id.example.ts.net",
          clientId: "family-agenda",
          clientSecret: "s3cret",
        },
        redirectUri: `${origin}/sso/callback`,
      });
    });

    it("links the Admin with the same verified email and later finds them by the provider's id", async () => {
      const first = await signInAs(anna);
      const again = await signInAs({ ...anna, email: "other@example.org" });

      for (const result of [first, again]) {
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(
          (await instance.app.admins.authenticate(result.sessionToken))?.email,
        ).toBe("anna@example.org");
      }
      expect(await instance.app.admins.listAdmins()).toHaveLength(1);
    });

    it("keeps the password working for a linked Admin", async () => {
      await signInAs(anna);

      const result = await instance.app.admins.signIn({
        email: "anna@example.org",
        password,
        client: "192.0.2.1",
      });

      expect(result.ok).toBe(true);
    });

    it("creates an Admin without a password for an unknown, verified email", async () => {
      const result = await signInAs({
        ...anna,
        subject: "sub-ben",
        email: "Ben@example.org",
      });

      expect(result.ok).toBe(true);
      expect(
        (await instance.app.admins.listAdmins()).map((admin) => admin.email),
      ).toContain("ben@example.org");
      expect(
        await instance.query(
          "SELECT password_hash FROM admin WHERE email = 'ben@example.org'",
        ),
      ).toEqual([{ password_hash: null }]);
      expect(
        await instance.app.admins.signIn({
          email: "ben@example.org",
          password: "",
          client: "192.0.2.1",
        }),
      ).toEqual({
        ok: false,
        problem: "invalid-credentials",
      });
    });

    it("lets another Admin set a password for one who has none", async () => {
      await signInAs({ ...anna, subject: "sub-ben", email: "ben@example.org" });
      const ben = (await instance.app.admins.listAdmins()).find(
        (admin) => admin.email === "ben@example.org",
      );
      const actor = (await instance.app.admins.listAdmins()).find(
        (admin) => admin.email === "anna@example.org",
      );
      if (!ben || !actor) throw new Error("missing admins");

      await instance.app.admins.resetPassword(actor, {
        adminId: ben.id,
        newPassword: "another long password",
      });

      expect(
        (
          await instance.app.admins.signIn({
            email: "ben@example.org",
            password: "another long password",
            client: "192.0.2.1",
          })
        ).ok,
      ).toBe(true);
    });

    it("refuses someone outside the required group, every time", async () => {
      const first = await signInAs(anna);
      expect(first.ok).toBe(true);

      expect(await signInAs({ ...anna, groups: ["family"] })).toEqual({
        ok: false,
        problem: "sso-not-in-group",
      });
      expect(await instance.app.admins.listAdmins()).toHaveLength(1);
    });

    it("lets a running session go on when the Admin has left the group", async () => {
      const first = await signInAs(anna);
      if (!first.ok) throw new Error("sign-in failed");

      await signInAs({ ...anna, groups: [] });

      expect(
        await instance.app.admins.authenticate(first.sessionToken),
      ).not.toBeNull();
    });

    it("refuses an email the provider has not verified, or none", async () => {
      expect(
        await signInAs({ ...anna, subject: "sub-x", emailVerified: false }),
      ).toEqual({
        ok: false,
        problem: "sso-email-unverified",
      });
      expect(
        await signInAs({
          ...anna,
          subject: "sub-y",
          email: null as unknown as string,
        }),
      ).toEqual({
        ok: false,
        problem: "sso-email-unverified",
      });
    });

    it("refuses another identity for an email that is already linked", async () => {
      await signInAs(anna);

      expect(await signInAs({ ...anna, subject: "sub-impostor" })).toEqual({
        ok: false,
        problem: "sso-conflict",
      });
    });

    it("fails for a return that does not belong to the sign-in it began", async () => {
      const begun = await sso().begin(origin);
      const other = await sso().begin(origin);
      if (!begun || !other) throw new Error("sign-in not offered");

      const result = await sso().complete({
        baseUrl: origin,
        query: provider.returnWith(other.pending, anna),
        pending: begun.pending,
      });

      expect(result).toEqual({ ok: false, problem: "sso-failed" });
    });

    it("fails at an origin where it is not offered", async () => {
      const begun = await sso().begin(origin);
      if (!begun) throw new Error("sign-in not offered");

      const result = await sso().complete({
        baseUrl: "http://family-agenda.local",
        query: provider.returnWith(begun.pending, anna),
        pending: begun.pending,
      });

      expect(result).toEqual({ ok: false, problem: "sso-failed" });
    });
  });

  it("is offered nowhere without an Identity Provider", async () => {
    await instance.close();
    instance = await bootForTest({ identityProviderClient: provider });

    expect(sso().isOfferedAt(origin)).toBe(false);
    expect(await sso().begin(origin)).toBeNull();
  });

  it("makes the first Admin on an Instance without one", async () => {
    await instance.close();
    instance = await bootForTest({ identityProviderClient: provider, identityProvider: settings });

    expect((await signInAs(anna)).ok).toBe(true);
    expect(await instance.app.admins.needsFirstAdmin()).toBe(false);
  });
});

describe("the Identity Provider from the environment", () => {
  const variables = {
    issuerUrl: " https://id.example.ts.net/realms/home/ ",
    clientId: " family-agenda ",
    clientSecret: "s3cret",
    publicBaseUrl: origin,
  };

  it("is none without an issuer", () => {
    expect(parseIdentityProviderSettings({})).toEqual({ ok: true, settings: null });
    expect(parseIdentityProviderSettings({ ...variables, issuerUrl: " " })).toEqual({ ok: true, settings: null });
  });

  it("keeps the issuer's path and takes the default group", () => {
    expect(parseIdentityProviderSettings(variables)).toEqual({
      ok: true,
      settings: {
        issuerUrl: "https://id.example.ts.net/realms/home",
        clientId: "family-agenda",
        clientSecret: "s3cret",
        requiredGroup: "homelab-admin",
        publicBaseUrl: origin,
      },
    });
  });

  it("keeps an issuer with a trailing slash as before, without the slash", () => {
    const parsed = parseIdentityProviderSettings({ ...variables, issuerUrl: "https://id.example.ts.net/" });
    expect(parsed.ok && parsed.settings?.issuerUrl).toBe("https://id.example.ts.net");
  });

  it("keeps the path prefix of the public base URL, without a trailing slash", () => {
    const parsed = parseIdentityProviderSettings({ ...variables, publicBaseUrl: `${origin}/agenda/` });
    expect(parsed.ok && parsed.settings?.publicBaseUrl).toBe(`${origin}/agenda`);
  });

  it.each([
    ["invalid-issuer-url", { issuerUrl: "id.example" }],
    ["invalid-issuer-url", { issuerUrl: "https://id.example?x=1" }],
    ["invalid-issuer-url", { issuerUrl: "ftp://id.example" }],
    ["invalid-issuer-url", { issuerUrl: "https://user:pw@id.example" }],
    ["invalid-client-id", { clientId: undefined }],
    ["invalid-client-id", { clientId: "x".repeat(201) }],
    ["client-secret-missing", { clientSecret: " " }],
    ["client-secret-missing", { clientSecret: undefined }],
    ["invalid-required-group", { requiredGroup: " " }],
    ["invalid-public-url", { publicBaseUrl: null }],
  ])("refuses %s", (problem, change) => {
    expect(parseIdentityProviderSettings({ ...variables, ...change })).toEqual({ ok: false, problem });
  });
});

describe("signing in through an Identity Provider only as a known Admin", () => {
  const knownOnly = { ...settings, knownAdminsOnly: true };
  let instance: TestInstance;
  let provider: ScriptedIdentityProviderClient;
  beforeEach(async () => {
    provider = new ScriptedIdentityProviderClient();
    instance = await bootForTest({ identityProviderClient: provider, identityProvider: knownOnly });
  });
  afterEach(async () => {
    await instance.close();
  });

  const signInAs = async (identity: typeof anna) => {
    const sso = instance.app.singleSignOn;
    const begun = await sso.begin(origin);
    if (!begun) throw new Error("sign-in not offered");
    return sso.complete({ baseUrl: origin, query: provider.returnWith(begun.pending, identity), pending: begun.pending });
  };

  it("signs in the Admin with the verified email and ties them to the identity", async () => {
    await instance.app.admins.createFirstAdmin({ email: "anna@example.org", password });

    const first = await signInAs(anna);
    const again = await signInAs({ ...anna, email: "other@example.org" });

    expect(first.ok && again.ok).toBe(true);
    expect(await instance.app.admins.listAdmins()).toHaveLength(1);
  });

  it("refuses someone in the group whose email belongs to no Admin, and adds no Admin", async () => {
    await instance.app.admins.createFirstAdmin({ email: "anna@example.org", password });

    expect(await signInAs({ ...anna, subject: "sub-ben", email: "ben@example.org" })).toEqual({ ok: false, problem: "sso-unknown-admin" });
    expect(await instance.app.admins.listAdmins()).toHaveLength(1);
  });

  it("refuses an email the provider has not verified, even of a known Admin", async () => {
    await instance.app.admins.createFirstAdmin({ email: "anna@example.org", password });

    expect(await signInAs({ ...anna, emailVerified: false })).toEqual({ ok: false, problem: "sso-email-unverified" });
  });

  it("makes no first Admin on a Family without one", async () => {
    expect(await signInAs(anna)).toEqual({ ok: false, problem: "sso-unknown-admin" });
    expect(await instance.app.admins.needsFirstAdmin()).toBe(true);
    expect(instance.app.singleSignOn.makesFirstAdminAt(origin)).toBe(false);
  });

  it("signs in an Admin entered by email address without a password", async () => {
    await instance.app.admins.enterAdmin({ email: "anna@example.org" });

    expect((await signInAs(anna)).ok).toBe(true);
  });

  it("signs in an Admin another Admin added by email address alone", async () => {
    await instance.app.admins.createFirstAdmin({ email: "anna@example.org", password });

    expect(await instance.app.admins.createAdmin({ email: "ben@example.org", password: "" })).toEqual({ ok: true });

    expect((await signInAs({ ...anna, subject: "sub-ben", email: "ben@example.org" })).ok).toBe(true);
    expect((await instance.app.admins.signIn({ email: "ben@example.org", password: "", client: "192.0.2.1" })).ok).toBe(false);
  });

  it("does not tie a known Admin already tied to another identity", async () => {
    await instance.app.admins.enterAdmin({ email: "anna@example.org" });
    await signInAs(anna);

    expect(await signInAs({ ...anna, subject: "sub-impostor" })).toEqual({ ok: false, problem: "sso-conflict" });
  });
});

describe("the switch for known Admins only", () => {
  const variables = { issuerUrl: "https://id.example.ts.net", clientId: "family-agenda", clientSecret: "s3cret", publicBaseUrl: origin };
  const switched = (knownAdminsOnly: string | boolean | undefined) => {
    const parsed = parseIdentityProviderSettings({ ...variables, knownAdminsOnly });
    return parsed.ok ? (parsed.settings?.knownAdminsOnly ?? false) : parsed.problem;
  };

  it("is off unless set", () => {
    expect(switched(undefined)).toBe(false);
    expect(switched("")).toBe(false);
    expect(switched(false)).toBe(false);
    expect(switched("false")).toBe(false);
  });

  it("is on when set", () => {
    expect(switched(true)).toBe(true);
    expect(switched(" true ")).toBe(true);
  });

  it("is refused for anything else", () => {
    expect(switched("yes")).toBe("invalid-known-admins-only");
  });

  it("makes the first Admin without it", async () => {
    const instance = await bootForTest({ identityProvider: settings });
    expect(instance.app.singleSignOn.makesFirstAdminAt(origin)).toBe(true);
    expect(instance.app.singleSignOn.makesFirstAdminAt("http://family-agenda.local")).toBe(false);
    await instance.close();
  });
});
