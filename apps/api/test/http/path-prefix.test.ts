import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { bootHttpForTestBelow, signedInCookie, type HttpPrefixedTestInstance } from "../support/http";
import { FakeIdentityProvider } from "../../../../packages/adapters/test/support/fake-identity-provider";

const prefix = "/agenda";
const identityProvider = {
  issuerUrl: "https://id.example.ts.net",
  clientId: "family-agenda",
  clientSecret: "s3cret",
  requiredGroup: "homelab-admin",
  groupsClaim: "groups",
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

  it("sends a browser to sign in, and signs out, all below the prefix", async () => {
    instance = await bootHttpForTestBelow(prefix);

    const first = await instance.get(`${prefix}/admin`);
    expect(first.headers.get("location")).toBe(`${prefix}/admin/sign-in`);
    const signInPage = await (await instance.get(`${prefix}/admin/sign-in`)).text();
    expect(signInPage).toContain(`href="${prefix}/static/design.css"`);

    const session = await signedInCookie(instance);
    const kit = await instance.get(`${prefix}/admin`, { cookie: session });
    expect(kit.headers.get("location")).toBe(`${prefix}/admin/recovery-kit`);
    const kitPage = await (await instance.get(`${prefix}/admin/recovery-kit`, { cookie: session })).text();
    expect(kitPage).toContain(`action="${prefix}/admin/sign-out"`);
    const confirmed = await instance.post(`${prefix}/admin/recovery-kit/confirm`, { saved: "yes" }, { cookie: session });
    expect(confirmed.headers.get("location")).toBe(`${prefix}/admin`);
    expect((await instance.get(`${prefix}/admin`, { cookie: session })).status).toBe(200);
    expect((await instance.get(`${prefix}/`)).headers.get("location")).toBe(`${prefix}/admin`);

    const signedOut = await instance.post(`${prefix}/admin/sign-out`, {}, { cookie: session });
    expect(signedOut.headers.get("location")).toBe(`${prefix}/admin/sign-in`);
    expect(cookieOf(signedOut, "fb_session").path).toBe(prefix);
    const away = await instance.get(`${prefix}/admin`, { cookie: session });
    expect(away.headers.get("location")).toBe(`${prefix}/admin/sign-in`);
  });

  it("signs an Admin in through the Identity Provider, with the callback below the prefix", async () => {
    const provider = await FakeIdentityProvider.start();
    onTestFinished(() => provider.stop());
    instance = await bootHttpForTestBelow(prefix, {}, { identityProvider: { ...identityProvider, issuerUrl: provider.issuer } });

    expect(await (await instance.get(`${prefix}/admin/sign-in`)).text()).toContain(`href="${prefix}/sso/start"`);
    const start = await instance.get(`${prefix}/sso/start`);
    const location = start.headers.get("location") ?? "";
    expect(new URL(location).searchParams.get("redirect_uri")).toBe(`http://localhost${prefix}/sso/callback`);
    const sso = cookieOf(start, "fb_sso");
    expect(sso.path).toBe(`${prefix}/sso`);
    const callback = new URL(await provider.authorize(location));
    expect(callback.pathname).toBe(`${prefix}/sso/callback`);

    const back = await instance.get(`${callback.pathname}${callback.search}`, { cookie: sso.pair });

    expect(back.headers.get("location")).toBe(`${prefix}/admin`);
    expect(cookieOf(back, "fb_sso").path).toBe(`${prefix}/sso`);
    expect(cookieOf(back, "fb_session").path).toBe(prefix);
  });

  it("adds, changes and removes Family Members and Agendas, all below the prefix", async () => {
    instance = await bootHttpForTestBelow(prefix);
    await instance.app.recoveryKit.confirm();
    const cookie = await signedInCookie(instance);
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
  });

  it("keeps the settings pages and their background requests below the prefix", async () => {
    instance = await bootHttpForTestBelow(prefix);
    await instance.app.recoveryKit.confirm();
    const cookie = await signedInCookie(instance);
    for (const path of ["/admin", "/admin/agendas", "/admin/display", "/admin/llm", "/admin/recovery-kit"]) {
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
