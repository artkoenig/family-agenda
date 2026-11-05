import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootHttpForTest,
  sessionCookieOf,
  type HttpTestInstance,
} from "../support/http";
import { ScriptedIdentityProviderClient } from "../support/scripted-identity-provider";

const password = "correct horse battery";
const form = {
  enabled: "yes",
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
    instance = await bootHttpForTest({}, { identityProviderClient: provider });
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

  const save = (changes: Record<string, string> = {}) =>
    instance.post("/admin/sso", { ...form, ...changes }, { cookie });

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

  it("shows the settings with the redirect URI and the stored secret hidden", async () => {
    await save();

    const page = await (await instance.get("/admin/sso", { cookie })).text();

    expect(page).toContain("http://localhost/sso/callback");
    expect(page).toContain("openid email profile groups");
    expect(page).toContain("homelab-admin");
    expect(page).not.toContain("s3cret");
    expect(page).toContain("Stored; leave empty to keep it");
  });

  it("suggests the address it was reached at and the default group before anything is saved", async () => {
    const page = await (await instance.get("/admin/sso", { cookie })).text();

    expect(page).toContain('value="homelab-admin"');
    expect(page).toContain('value="http://localhost"');
  });

  it("lists single sign-on in the settings as off, then on", async () => {
    expect(
      await (await instance.get("/admin/sso", { cookie })).text(),
    ).toContain("Off");

    await save();

    expect(
      await (await instance.get("/admin/sso", { cookie })).text(),
    ).toContain("On");
  });

  it("refuses settings with a problem, showing what was entered", async () => {
    const response = await save({ clientId: " ", requiredGroup: "parents" });

    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain("Enter the client ID.");
    expect(page).toContain('value="parents"');
  });

  it("does not save while the provider cannot be reached, and says why", async () => {
    provider.discoveryFailure = "connect ECONNREFUSED";

    const response = await save();

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("could not be reached");
    expect(await instance.app.singleSignOn.current()).toBeNull();
  });

  it("offers the button on the public base URL only", async () => {
    await save();

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

  it("offers no button before it is set up, and no start or callback", async () => {
    expect(await (await instance.get("/admin/sign-in")).text()).not.toContain(
      "/sso/start",
    );
    expect((await instance.get("/sso/start")).status).toBe(404);
    expect((await instance.get("/sso/callback?code=x&state=y")).status).toBe(
      404,
    );
  });

  it("hides the start where the button is hidden", async () => {
    await save();

    expect(
      (
        await instance.get("/sso/start", {
          headers: { host: "family-agenda.local" },
        })
      ).status,
    ).toBe(404);
  });

  it("signs the Admin in with a session of Family Agenda's own after the Identity Provider's return", async () => {
    await save();
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

  it("creates an Admin who sees only the Recovery Kit until it is confirmed", async () => {
    await instance.close();
    instance = await bootHttpForTest({}, { identityProviderClient: provider });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.singleSignOn.save({ ...form, enabled: true });
    const { ssoCookie, callback } = await startSignIn({
      ...anna,
      subject: "sub-ben",
      email: "ben@example.org",
    });

    const response = await instance.get(callback, { cookie: ssoCookie });

    expect(response.status).toBe(303);
    const redirected = await instance.get("/admin/agendas", {
      cookie: sessionOf(response),
    });
    expect(redirected.headers.get("location")).toBe("/admin/recovery-kit");
  });

  it("refuses someone outside the required group", async () => {
    await save();
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
    await save();
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
    await save();

    const response = await instance.post("/admin/sign-in", {
      email: "anna@example.org",
      password,
    });

    expect(response.status).toBe(303);
  });
});
