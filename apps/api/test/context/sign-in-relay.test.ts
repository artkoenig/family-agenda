import { describe, expect, it } from "vitest";
import { SignInRelay } from "../../src/context/sign-in-relay";
import { ScriptedIdentityProviderClient } from "../support/scripted-identity-provider";

const callbackUrl = "https://sign-in.example.org/sso/return";
const returnTo = "https://one.example.org";
const identityProvider = {
  issuerUrl: "https://id.example.org",
  clientId: "family-agenda",
  clientSecret: "s3cret",
  requiredGroup: "homelab-admin",
  groupsClaim: "groups",
  familyIdClaim: "custom_data.familyId",
  callbackUrl,
  organizations: { scope: "urn:logto:scope:organizations", claim: "organizations" },
};
const anna = { subject: "sub-anna", email: "anna@example.org", emailVerified: true, groups: [], familyId: "family-1" };

describe("the one callback of a supplied core with a management API (ADR-0010)", () => {
  const signIn = async (organizationId: string | null, organizations: string[]) => {
    const client = new ScriptedIdentityProviderClient();
    const relay = new SignInRelay({ contextKey: "a-context-key-of-at-least-32-characters", identityProvider, client });
    const begun = await client.begin(identityProvider, callbackUrl, relay.stateOf("family-1", returnTo, "binding", organizationId));
    const back = await relay.callback(new Request(callbackUrl + client.returnWith(begun.pending, { ...anna, organizations })));
    return back.headers.get("location") ?? "";
  };

  it("hands over a member of the organization the Family's state names", async () => {
    expect(await signIn("org-1", ["org-1"])).toMatch(/^https:\/\/one\.example\.org\/sso\/handover\?token=/);
  });

  it("refuses anyone else, the Family claim notwithstanding, and anyone before the Family has an organization", async () => {
    expect(await signIn("org-1", ["org-2"])).toBe(`${returnTo}/admin/sign-in?problem=sso-not-member`);
    expect(await signIn(null, ["org-1"])).toBe(`${returnTo}/admin/sign-in?problem=sso-not-member`);
  });
});
