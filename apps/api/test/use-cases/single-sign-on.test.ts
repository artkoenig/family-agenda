import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { parseFamilyIdClaim, parseIdentityProviderSettings } from "@family-agenda/application";
import { ScriptedIdentityProviderClient } from "../support/scripted-identity-provider";
import { InMemoryIdentityDirectory } from "../support/in-memory-identity-directory";

const origin = "https://agenda.example.ts.net";
const settings = {
  issuerUrl: "https://id.example.ts.net",
  clientId: "family-agenda",
  clientSecret: "s3cret",
  requiredGroup: "homelab-admin",
  groupsClaim: "groups",
  publicBaseUrl: origin,
};
const anna = {
  subject: "sub-anna",
  email: "anna@example.org",
  emailVerified: true,
  groups: ["homelab-admin"],
  familyId: null as string | null,
  organizations: [] as string[],
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
          groupsClaim: "groups",
        },
        redirectUri: `${origin}/sso/callback`,
      });
    });

    it("starts a session that holds the identity, without storing an Admin", async () => {
      const result = await signInAs(anna);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(await instance.app.admins.authenticate(result.sessionToken)).toEqual({ subject: "sub-anna", email: "anna@example.org" });
      expect(await instance.query("SELECT subject, email FROM admin_session")).toEqual([{ subject: "sub-anna", email: "anna@example.org" }]);
    });

    it("signs in anyone in the required group, whom no one entered before", async () => {
      const result = await signInAs({ ...anna, subject: "sub-ben", email: "ben@example.org" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((await instance.app.admins.authenticate(result.sessionToken))?.email).toBe("ben@example.org");
    });

    it("refuses someone outside the required group, every time", async () => {
      expect((await signInAs(anna)).ok).toBe(true);

      expect(await signInAs({ ...anna, groups: ["family"] })).toEqual({ ok: false, problem: "sso-not-in-group" });
      expect(await signInAs({ ...anna, groups: [] })).toEqual({ ok: false, problem: "sso-not-in-group" });
    });

    it("lets a running session go on when the Admin has left the group", async () => {
      const first = await signInAs(anna);
      if (!first.ok) throw new Error("sign-in failed");

      await signInAs({ ...anna, groups: [] });

      expect(await instance.app.admins.authenticate(first.sessionToken)).not.toBeNull();
    });

    it("ends a session after 12 hours, so the browser goes through the provider again", async () => {
      const result = await signInAs(anna);
      if (!result.ok) throw new Error("sign-in failed");

      instance.clock.advance(12 * 60 * 60 * 1000 - 1);
      expect(await instance.app.admins.authenticate(result.sessionToken)).not.toBeNull();
      instance.clock.advance(1);
      expect(await instance.app.admins.authenticate(result.sessionToken)).toBeNull();
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

  describe("in supplied mode, where the Family claim decides", () => {
    const familyId = "0d6c4c3e-6a4f-4a4e-9a8e-2f5a3c1b7e10";
    beforeEach(async () => {
      await instance.close();
      instance = await bootForTest({
        identityProviderClient: provider,
        identityProvider: { ...settings, family: { claim: "custom_data.familyId", familyId } },
      });
    });

    it("asks the provider for the Family claim", async () => {
      await sso().begin(origin);

      expect(provider.begun[0]?.connection.familyIdClaim).toBe("custom_data.familyId");
    });

    it("signs in someone whose Family claim names the Family, in no group", async () => {
      expect((await signInAs({ ...anna, groups: [], familyId })).ok).toBe(true);
    });

    it("refuses a token without the Family claim, and one naming another Family", async () => {
      expect(await signInAs(anna)).toEqual({ ok: false, problem: "sso-no-family" });
      expect(await signInAs({ ...anna, familyId: "another" })).toEqual({ ok: false, problem: "sso-other-family" });
    });
  });

  describe("with a management API, where membership of the Family's organization decides (ADR-0010)", () => {
    const organizations = { scope: "urn:logto:scope:organizations", claim: "organizations" };
    const familyId = "0d6c4c3e-6a4f-4a4e-9a8e-2f5a3c1b7e10";
    const boot = async (family?: { claim: string; familyId: string }) => {
      await instance.close();
      instance = await bootForTest({
        identityProviderClient: provider,
        identityProvider: { ...settings, organizations, ...(family ? { family } : {}) },
      });
    };

    it("asks the provider for the organizations claim", async () => {
      await boot();
      await sso().begin(origin);

      expect(provider.begun[0]?.connection.organizations).toEqual(organizations);
    });

    it("signs in a member of the Family's organization, in no group", async () => {
      await boot();
      await instance.query("update family set organization_id = 'org-1'");

      expect((await signInAs({ ...anna, groups: [], organizations: ["org-0", "org-1"] })).ok).toBe(true);
    });

    it("refuses someone of another organization, the required group notwithstanding, and anyone before the Family's organization exists", async () => {
      await boot();
      expect(await signInAs({ ...anna, organizations: ["org-1"] })).toEqual({ ok: false, problem: "sso-not-member" });

      await instance.query("update family set organization_id = 'org-1'");
      expect(await signInAs({ ...anna, organizations: ["org-2"] })).toEqual({ ok: false, problem: "sso-not-member" });
    });

    describe("an invitee, not yet a member", () => {
      let directory: InMemoryIdentityDirectory;
      let organizationId: string;
      const week = 7 * 24 * 3_600_000;
      const details = { link: `${origin}/admin/sign-in`, locale: "en" };
      beforeEach(async () => {
        directory = new InMemoryIdentityDirectory();
        await instance.close();
        instance = await bootForTest({ identityProviderClient: provider, identityProvider: { ...settings, organizations }, identityDirectoryClient: directory });
        organizationId = await directory.createOrganization(familyId, "The Müllers");
        await directory.createOrganization("another-family", "Others");
        await instance.query(`update family set organization_id = '${organizationId}'`);
      });
      const invite = (email: string, expiresInMs = week) =>
        directory.invite(organizationId, email, { ...details, expiresAt: new Date(instance.clock.now().getTime() + expiresInMs) });
      const ben = { ...anna, subject: "user-ben", email: "Ben@Example.org", groups: [] };

      it("becomes an Admin by signing in with the invited email: a member, the invitation accepted", async () => {
        await invite("carl@example.org");
        const invitation = await invite("ben@example.org");

        expect((await signInAs(ben)).ok).toBe(true);
        expect([...directory.organization(organizationId).members.keys()]).toEqual(["user-ben"]);
        expect(directory.organization(organizationId).accepted.map((accepted) => accepted.invitationId)).toEqual([invitation.invitationId]);
        expect((await directory.listInvitations(organizationId)).map((pending) => pending.email)).toEqual(["carl@example.org"]);
      });

      it("is refused with an expired invitation, a revoked one, one of another organization, or an unverified email", async () => {
        await invite("ben@example.org", 1_000);
        instance.clock.advance(1_000);
        expect(await signInAs(ben)).toEqual({ ok: false, problem: "sso-not-member" });

        const revoked = await invite("ben@example.org");
        await directory.revokeInvitation(organizationId, revoked.invitationId);
        expect(await signInAs(ben)).toEqual({ ok: false, problem: "sso-not-member" });

        const [other] = [...directory.organizations.keys()].filter((id) => id !== organizationId);
        await directory.invite(other ?? "", "ben@example.org", { ...details, expiresAt: new Date(instance.clock.now().getTime() + week) });
        expect(await signInAs(ben)).toEqual({ ok: false, problem: "sso-not-member" });

        await invite("ben@example.org");
        expect(await signInAs({ ...ben, emailVerified: false })).toEqual({ ok: false, problem: "sso-not-member" });
        expect(await signInAs({ ...ben, email: "  " })).toEqual({ ok: false, problem: "sso-not-member" });
        expect(directory.organization(organizationId).members.size).toBe(0);
      });
    });

    it("in supplied mode too, instead of the Family claim", async () => {
      await boot({ claim: "custom_data.familyId", familyId });
      await instance.query("update family set organization_id = 'org-1'");

      expect((await signInAs({ ...anna, organizations: ["org-1"] })).ok).toBe(true);
      expect(await signInAs({ ...anna, familyId, organizations: [] })).toEqual({ ok: false, problem: "sso-not-member" });
    });
  });

  it("is offered nowhere without an Identity Provider", async () => {
    await instance.close();
    instance = await bootForTest({ identityProviderClient: provider });

    expect(sso().isOfferedAt(origin)).toBe(false);
    expect(await sso().begin(origin)).toBeNull();
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
        groupsClaim: "groups",
        publicBaseUrl: origin,
      },
    });
  });

  it("takes the groups from another claim when told to", () => {
    const parsed = parseIdentityProviderSettings({ ...variables, groupsClaim: " roles " });
    expect(parsed.ok && parsed.settings?.groupsClaim).toBe("roles");
  });

  it("keeps an issuer with a trailing slash as before, without the slash", () => {
    const parsed = parseIdentityProviderSettings({ ...variables, issuerUrl: "https://id.example.ts.net/" });
    expect(parsed.ok && parsed.settings?.issuerUrl).toBe("https://id.example.ts.net");
  });

  it("keeps the path prefix of the public base URL, without a trailing slash", () => {
    const parsed = parseIdentityProviderSettings({ ...variables, publicBaseUrl: `${origin}/agenda/` });
    expect(parsed.ok && parsed.settings?.publicBaseUrl).toBe(`${origin}/agenda`);
  });

  it("reads the Family claim as a dotted path, family_id by default", () => {
    expect(parseFamilyIdClaim(undefined)).toBe("family_id");
    expect(parseFamilyIdClaim("")).toBe("family_id");
    expect(parseFamilyIdClaim(" custom_data.familyId ")).toBe("custom_data.familyId");
    for (const odd of ["a..b", ".a", "a.", "a b", "x".repeat(201)]) expect(parseFamilyIdClaim(odd)).toBeNull();
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
    ["invalid-groups-claim", { groupsClaim: " " }],
    ["invalid-groups-claim", { groupsClaim: "groups roles" }],
  ])("refuses %s", (problem, change) => {
    expect(parseIdentityProviderSettings({ ...variables, ...change })).toEqual({ ok: false, problem });
  });
});
