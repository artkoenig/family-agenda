import { afterEach, describe, expect, it } from "vitest";
import { bootHttpForTestBelow, type HttpPrefixedTestInstance } from "../support/http";
import { ScriptedIdentityProviderClient } from "../support/scripted-identity-provider";

const password = "correct horse battery";
const prefix = "/agenda";
const anna = { subject: "sub-anna", email: "anna@example.org", emailVerified: true, groups: ["homelab-admin"] };
const identityProvider = {
  issuerUrl: "https://id.example.ts.net",
  clientId: "family-agenda",
  clientSecret: "s3cret",
  requiredGroup: "homelab-admin",
  publicBaseUrl: `http://localhost${prefix}`,
};

/** The `name=value` pair of a cookie a response sets, and the path it is valid for. */
const cookieOf = (response: Response, name: string) => {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`)) ?? "";
  return { pair: header.split(";")[0] ?? "", path: /Path=([^;]*)/i.exec(header)?.[1] };
};

describe("an Instance below a path prefix", () => {
  let instance: HttpPrefixedTestInstance;
  afterEach(async () => {
    await instance.close();
  });

  it("sets up the first Admin, signs in and out, all below the prefix", async () => {
    instance = await bootHttpForTestBelow(prefix);

    const first = await instance.get(`${prefix}/admin`);
    expect(first.headers.get("location")).toBe(`${prefix}/setup`);
    const setup = await (await instance.get(`${prefix}/setup`)).text();
    expect(setup).toContain(`action="${prefix}/setup"`);
    expect(setup).toContain(`href="${prefix}/static/design.css"`);

    const created = await instance.post(`${prefix}/setup`, { email: "anna@example.org", password });
    expect(created.headers.get("location")).toBe(`${prefix}/admin/recovery-kit`);
    const session = cookieOf(created, "fb_session");
    expect(session.path).toBe(prefix);

    const kit = await instance.get(`${prefix}/admin`, { cookie: session.pair });
    expect(kit.headers.get("location")).toBe(`${prefix}/admin/recovery-kit`);
    const kitPage = await (await instance.get(`${prefix}/admin/recovery-kit`, { cookie: session.pair })).text();
    expect(kitPage).toContain(`action="${prefix}/admin/sign-out"`);
    const confirmed = await instance.post(`${prefix}/admin/recovery-kit/confirm`, { saved: "yes" }, { cookie: session.pair });
    expect(confirmed.headers.get("location")).toBe(`${prefix}/admin`);

    const signedOut = await instance.post(`${prefix}/admin/sign-out`, {}, { cookie: session.pair });
    expect(signedOut.headers.get("location")).toBe(`${prefix}/admin/sign-in`);
    expect(cookieOf(signedOut, "fb_session").path).toBe(prefix);
    const away = await instance.get(`${prefix}/admin`, { cookie: session.pair });
    expect(away.headers.get("location")).toBe(`${prefix}/admin/sign-in`);

    const signInPage = await (await instance.get(`${prefix}/admin/sign-in`)).text();
    expect(signInPage).toContain(`action="${prefix}/admin/sign-in"`);
    const signedIn = await instance.post(`${prefix}/admin/sign-in`, { email: "anna@example.org", password });
    expect(signedIn.headers.get("location")).toBe(`${prefix}/admin`);
    expect((await instance.get(`${prefix}/admin`, { cookie: cookieOf(signedIn, "fb_session").pair })).status).toBe(200);
    expect((await instance.get(`${prefix}/`)).headers.get("location")).toBe(`${prefix}/admin`);
  });

  it("signs the first Admin in through the Identity Provider, with the callback below the prefix", async () => {
    const provider = new ScriptedIdentityProviderClient();
    instance = await bootHttpForTestBelow(prefix, {}, { identityProviderClient: provider, identityProvider });

    expect(await (await instance.get(`${prefix}/setup`)).text()).toContain(`href="${prefix}/sso/start"`);
    const start = await instance.get(`${prefix}/sso/start`);
    expect(provider.begun[0]?.redirectUri).toBe(`http://localhost${prefix}/sso/callback`);
    const sso = cookieOf(start, "fb_sso");
    expect(sso.path).toBe(`${prefix}/sso`);
    const pending = JSON.parse(decodeURIComponent(sso.pair.split("=").slice(1).join("="))) as Parameters<typeof provider.returnWith>[0];

    const back = await instance.get(`${prefix}/sso/callback${provider.returnWith(pending, anna)}`, { cookie: sso.pair });

    expect(back.headers.get("location")).toBe(`${prefix}/admin/recovery-kit`);
    expect(cookieOf(back, "fb_sso").path).toBe(`${prefix}/sso`);
    expect(cookieOf(back, "fb_session").path).toBe(prefix);
  });

  it("answers the health check without the prefix", async () => {
    instance = await bootHttpForTestBelow(prefix);

    expect((await instance.core.get("/api/health")).status).toBe(200);
  });
});
