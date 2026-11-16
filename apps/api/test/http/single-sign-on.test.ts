import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootHttpForTest,
  signedInCookie,
  type HttpTestInstance,
} from "../support/http";
import { FakeIdentityProvider, type IdTokenClaims } from "../../../../packages/adapters/test/support/fake-identity-provider";

/** The Identity Provider settings of an Instance that signs in through `provider`. */
const identityProviderOf = (provider: FakeIdentityProvider) => ({
  issuerUrl: provider.issuer,
  clientId: "family-agenda",
  clientSecret: "s3cret",
  requiredGroup: "homelab-admin",
  groupsClaim: "groups",
  publicBaseUrl: "http://localhost",
});
/** The session cookie a response sets among others. */
const sessionOf = (response: Response) =>
  /fb_session=[^;]+/.exec(response.headers.get("set-cookie") ?? "")?.[0] ?? "";

const anna: IdTokenClaims = {
  sub: "sub-anna",
  email: "anna@example.org",
  email_verified: true,
  groups: ["homelab-admin"],
};

/** The path and query of where the Identity Provider sends the browser back to. */
const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

describe("single sign-on over HTTP", () => {
  let instance: HttpTestInstance;
  let provider: FakeIdentityProvider;
  let identityProvider: ReturnType<typeof identityProviderOf>;
  let cookie: string;
  beforeEach(async () => {
    provider = await FakeIdentityProvider.start();
    identityProvider = identityProviderOf(provider);
    instance = await bootHttpForTest({}, { identityProvider });
    await instance.app.recoveryKit.confirm();
    cookie = await signedInCookie(instance);
  });
  afterEach(async () => {
    await instance.close();
    await provider.stop();
  });

  /** Starts a sign-in and returns the callback path the Identity Provider would send the browser back to. */
  const startSignIn = async (
    identity = anna,
    headers: Record<string, string> = {},
  ) => {
    const start = await instance.get("/sso/start", { headers });
    const ssoCookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const state =
      new URL(start.headers.get("location") ?? "http://x").searchParams.get(
        "state",
      ) ?? "";
    const pending = JSON.parse(
      decodeURIComponent(ssoCookie.split("=").slice(1).join("=")),
    ) as { state: string };
    expect(pending.state).toBe(state);
    provider.claims = identity;
    return {
      start,
      ssoCookie,
      callback: pathOf(await provider.authorize(start.headers.get("location") ?? "")),
    };
  };

  it("offers only the button, on the public base URL only", async () => {
    const there = await (await instance.get("/admin/sign-in")).text();
    const elsewhere = await (
      await instance.get("/admin/sign-in", {
        headers: { host: "family-agenda.local" },
      })
    ).text();

    expect(there).toContain('href="/sso/start"');
    expect(there).not.toContain('name="password"');
    expect(elsewhere).not.toContain("/sso/start");
    expect(elsewhere).not.toContain('name="password"');
  });

  it("offers no button, start or callback without an Identity Provider, and says why", async () => {
    await instance.close();
    instance = await bootHttpForTest({});

    const page = await (await instance.get("/admin/sign-in")).text();
    expect(page).not.toContain("/sso/start");
    expect(page).toContain("No Identity Provider is connected");
    expect((await instance.get("/sso/start")).status).toBe(404);
    expect((await instance.get("/sso/callback?code=x&state=y")).status).toBe(404);
  });

  it("has no settings page for it", async () => {
    expect((await instance.get("/admin/sso", { cookie })).status).toBe(404);
  });

  it("hides the start where the button is hidden", async () => {

    expect(
      (
        await instance.get("/sso/start", {
          headers: { host: "family-agenda.local" },
        })
      ).status,
    ).toBe(404);
  });

  it("signs the Admin in with a session of Family Agenda's own after the Identity Provider's return", async () => {
    const { start, ssoCookie, callback } = await startSignIn();
    expect(start.status).toBe(303);
    expect(start.headers.get("location")).toContain(
      `${provider.issuer}/authorize`,
    );

    const response = await instance.get(callback, { cookie: ssoCookie });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin");
    const session = response.headers.get("set-cookie") ?? "";
    expect(session).toMatch(/fb_session=/);
    expect(session).toMatch(/HttpOnly/i);
    const opened = await instance.get("/admin/agendas", {
      cookie: sessionOf(response),
    });
    expect(opened.status).toBe(200);
  });

  it("refuses someone outside the required group", async () => {
    const { ssoCookie, callback } = await startSignIn({
      ...anna,
      groups: ["family"],
    });

    const response = await instance.get(callback, { cookie: ssoCookie });

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie") ?? "").not.toMatch(
      /fb_session=[^;]/,
    );
    expect(await response.text()).toContain("not in the group or role that may administer Family Agenda");
  });

  it("sends a browser without a session, or with an expired one, through the Identity Provider", async () => {
    expect((await instance.get("/admin/agendas")).headers.get("location")).toBe("/sso/start");

    instance.clock.advance(12 * 60 * 60 * 1000);

    const expired = await instance.get("/admin/agendas", { cookie });
    expect(expired.status).toBe(302);
    expect(expired.headers.get("location")).toBe("/sso/start");
  });

  it("has no password sign-in, setup page or Admins page", async () => {
    expect((await instance.post("/admin/sign-in", { email: "anna@example.org", password: "correct horse battery" })).status).toBe(404);
    expect((await instance.get("/setup")).status).toBe(404);
    expect((await instance.get("/admin/admins", { cookie })).status).toBe(404);
  });

  it("refuses a return without the cookie of the sign-in it began", async () => {
    const { callback } = await startSignIn();

    const withoutCookie = await instance.get(callback);
    const garbled = await instance.get(callback, { cookie: "fb_sso=not-json" });
    const wrongShape = await instance.get(callback, {
      cookie: `fb_sso=${encodeURIComponent('{"state":1}')}`,
    });
    const notAnObject = await instance.get(callback, { cookie: "fb_sso=null" });

    for (const response of [withoutCookie, garbled, wrongShape, notAnObject])
      expect(response.status).toBe(401);
  });
});
