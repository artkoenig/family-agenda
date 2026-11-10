import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootHttpForTest,
  sessionCookieOf,
  type HttpTestInstance,
} from "../support/http";
import { ScriptedIdentityProviderClient } from "../support/scripted-identity-provider";

const password = "correct horse battery";
const identityProvider = {
  issuerUrl: "https://id.example.ts.net",
  clientId: "family-agenda",
  clientSecret: "s3cret",
  requiredGroup: "homelab-admin",
  publicBaseUrl: "http://localhost",
};
/** The session cookie a response sets among others. */
const sessionOf = (response: Response) =>
  /fb_session=[^;]+/.exec(response.headers.get("set-cookie") ?? "")?.[0] ?? "";

const anna = {
  subject: "sub-anna",
  email: "anna@example.org",
  emailVerified: true,
  groups: ["homelab-admin"],
};

describe("single sign-on over HTTP", () => {
  let instance: HttpTestInstance;
  let provider: ScriptedIdentityProviderClient;
  let cookie: string;
  beforeEach(async () => {
    provider = new ScriptedIdentityProviderClient();
    instance = await bootHttpForTest({}, { identityProviderClient: provider, identityProvider });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(
      await instance.post("/admin/sign-in", {
        email: "anna@example.org",
        password,
      }),
    );
  });
  afterEach(async () => {
    await instance.close();
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
    ) as {
      state: string;
      nonce: string;
      codeVerifier: string;
    };
    expect(pending.state).toBe(state);
    return {
      start,
      ssoCookie,
      callback: `/sso/callback${provider.returnWith(pending, identity)}`,
    };
  };

  it("offers the button on the public base URL only", async () => {
    const there = await (await instance.get("/admin/sign-in")).text();
    const elsewhere = await (
      await instance.get("/admin/sign-in", {
        headers: { host: "family-agenda.local" },
      })
    ).text();

    expect(there).toContain('href="/sso/start"');
    expect(there).toContain('name="password"');
    expect(elsewhere).not.toContain("/sso/start");
    expect(elsewhere).toContain('name="password"');
  });

  it("offers no button, start or callback without an Identity Provider", async () => {
    await instance.close();
    instance = await bootHttpForTest({}, { identityProviderClient: provider });
    await instance.post("/setup", { email: "anna@example.org", password });

    expect(await (await instance.get("/admin/sign-in")).text()).not.toContain("/sso/start");
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
      "https://id.example.ts.net/authorize",
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
    expect(await response.text()).toContain("not in the group");
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

  it("keeps the password sign-in working when single sign-on is on", async () => {

    const response = await instance.post("/admin/sign-in", {
      email: "anna@example.org",
      password,
    });

    expect(response.status).toBe(303);
  });

  describe("on an Instance without Admins", () => {
    beforeEach(async () => {
      await instance.close();
      instance = await bootHttpForTest({}, { identityProviderClient: provider, identityProvider });
    });

    it("offers the Identity Provider on the setup page", async () => {
      expect(await (await instance.get("/setup")).text()).toContain('href="/sso/start"');
    });

    it("makes the first Admin of someone in the required group, who sees the Recovery Kit next", async () => {
      const { ssoCookie, callback } = await startSignIn();

      const response = await instance.get(callback, { cookie: ssoCookie });

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/admin/recovery-kit");
      expect((await instance.app.admins.listAdmins()).map((admin) => admin.email)).toEqual(["anna@example.org"]);
      expect((await instance.get("/setup")).status).toBe(404);
    });

    it("stays on the setup page for someone outside the required group", async () => {
      const { ssoCookie, callback } = await startSignIn({ ...anna, groups: [] });

      const response = await instance.get(callback, { cookie: ssoCookie });

      expect(response.status).toBe(401);
      const page = await response.text();
      expect(page).toContain("not in the group");
      expect(page).toContain('action="/setup"');
      expect(await instance.app.admins.needsFirstAdmin()).toBe(true);
    });
  });
});
