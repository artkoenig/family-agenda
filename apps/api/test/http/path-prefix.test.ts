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

  it("adds, changes and removes Family Members, Admins and Agendas, all below the prefix", async () => {
    instance = await bootHttpForTestBelow(prefix);
    await instance.core.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    const cookie = cookieOf(await instance.post(`${prefix}/admin/sign-in`, { email: "anna@example.org", password }), "fb_session").pair;
    const page = async (path: string) => {
      const body = await (await instance.get(`${prefix}${path}`, { cookie })).text();
      // Every address the page emits from the root of the Instance lies below the prefix.
      expect(body.match(/(?:href|src|action|hx-get|hx-post)="\/(?!agenda\/)[^"]*"/g) ?? []).toEqual([]);
      return body;
    };
    const redirected = async (path: string, form: Record<string, string>) =>
      (await instance.post(`${prefix}${path}`, form, { cookie })).headers.get("location");

    expect(await page("/admin/family-members/new")).toContain(`action="${prefix}/admin/family-members"`);
    expect(await redirected("/admin/family-members", { name: "Mia" })).toBe(`${prefix}/admin/family-members`);
    const [mia] = await instance.app.familyMembers.list();
    if (!mia) throw new Error("Mia was not added");
    expect(await page(`/admin/family-members/${mia.id}`)).toContain(`action="${prefix}/admin/family-members/${mia.id}"`);
    expect(await redirected(`/admin/family-members/${mia.id}`, { name: "Mia Maria" })).toBe(`${prefix}/admin/family-members`);

    expect(await page("/admin/agendas/new")).toContain(`action="${prefix}/admin/agendas"`);
    expect(await redirected("/admin/agendas", { memberIds: mia.id, horizonDays: "7" })).toBe(`${prefix}/admin/agendas`);
    const [agenda] = await instance.app.agendas.list();
    if (!agenda) throw new Error("the Agenda was not created");
    const editing = await page(`/admin/agendas/${agenda.id}`);
    expect(editing).toContain(`href="http://localhost${prefix}/agendas/${agenda.id}"`);
    expect(editing).toContain(`href="http://localhost${prefix}/agendas/${agenda.id}/feed.ics"`);
    // The origin of PUBLIC_URL carries no path, so the copied address holds the prefix exactly once.
    const copied = /<a href="(http[^"]*)">/.exec(editing)?.[1];
    expect(copied).toBe(`http://localhost/agenda/agendas/${agenda.id}`);
    expect(await redirected(`/admin/agendas/${agenda.id}`, { memberIds: mia.id, horizonDays: "14" })).toBe(`${prefix}/admin/agendas`);
    expect(await redirected(`/admin/agendas/${agenda.id}/remove`, {})).toBe(`${prefix}/admin/agendas`);
    expect(await redirected(`/admin/family-members/${mia.id}/remove`, {})).toBe(`${prefix}/admin/family-members`);

    expect(await page("/admin/admins/new")).toContain(`action="${prefix}/admin/admins"`);
    expect(await redirected("/admin/admins", { email: "ben@example.org", password })).toBe(`${prefix}/admin/admins`);
    const ben = (await instance.app.admins.listAdmins()).find((admin) => admin.email === "ben@example.org");
    if (!ben) throw new Error("Ben was not added");
    expect(await page(`/admin/admins/${ben.id}`)).toContain(`action="${prefix}/admin/admins/${ben.id}/password"`);
    expect(await redirected(`/admin/admins/${ben.id}/password`, { password: "another horse battery" })).toBe(`${prefix}/admin/admins`);
  });

  it("keeps the settings pages and their background requests below the prefix", async () => {
    instance = await bootHttpForTestBelow(prefix);
    await instance.core.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    const cookie = cookieOf(await instance.post(`${prefix}/admin/sign-in`, { email: "anna@example.org", password }), "fb_session").pair;
    for (const path of ["/admin", "/admin/admins", "/admin/agendas", "/admin/display", "/admin/llm", "/admin/recovery-kit"]) {
      const body = await (await instance.get(`${prefix}${path}`, { cookie })).text();
      expect(body.match(/(?:href|src|action|hx-get|hx-post)="\/(?!agenda\/)[^"]*"/g) ?? [], path).toEqual([]);
    }
    expect(await (await instance.get(`${prefix}/admin/llm`, { cookie })).text()).toContain(`hx-post="${prefix}/admin/llm/test"`);
    const redirected = async (path: string, form: Record<string, string>) =>
      (await instance.post(`${prefix}${path}`, form, { cookie })).headers.get("location");
    expect(await redirected("/admin/display", { language: "de" })).toBe(`${prefix}/admin/display`);
    expect(await redirected("/admin/llm/ocr/enabled", { ocr: "yes" })).toBe(`${prefix}/admin/llm`);
    expect(await redirected("/admin/llm/remove", {})).toBe(`${prefix}/admin/llm`);
  });

  it("answers the health check without the prefix", async () => {
    instance = await bootHttpForTestBelow(prefix);

    expect((await instance.core.get("/api/health")).status).toBe(200);
  });
});
