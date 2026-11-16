import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";
import { FakeIdentityProvider } from "../../../../packages/adapters/test/support/fake-identity-provider";

/** The session cookie a response sets among others. */
const sessionOf = (response: Response) =>
  /fb_session=[^;]+/.exec(response.headers.get("set-cookie") ?? "")?.[0] ?? "";

describe("a fresh Instance (ADR-0009)", () => {
  let instance: HttpTestInstance;
  let provider: FakeIdentityProvider;
  beforeEach(async () => {
    provider = await FakeIdentityProvider.start();
    provider.claims = { sub: "sub-anna", email: "anna@example.org", email_verified: true, groups: ["homelab-admin"] };
    instance = await bootHttpForTest(
      {},
      {
        identityProvider: {
          issuerUrl: provider.issuer,
          clientId: "family-agenda",
          clientSecret: "s3cret",
          requiredGroup: "homelab-admin",
          groupsClaim: "groups",
          publicBaseUrl: "http://localhost",
        },
      },
    );
  });
  afterEach(async () => {
    await instance.close();
    await provider.stop();
  });

  /** Follows the first visit through the Identity Provider and returns the session cookie. */
  const signIn = async () => {
    expect((await instance.get("/")).headers.get("location")).toBe("/admin");
    expect((await instance.get("/admin")).headers.get("location")).toBe("/sso/start");
    const start = await instance.get("/sso/start");
    const ssoCookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const back = new URL(await provider.authorize(start.headers.get("location") ?? ""));
    const callback = await instance.get(`${back.pathname}${back.search}`, { cookie: ssoCookie });
    expect(callback.headers.get("location")).toBe("/admin");
    return sessionOf(callback);
  };

  it("offers sign-in through the Identity Provider, not a setup page", async () => {
    const page = await (await instance.get("/admin/sign-in")).text();
    expect(page).toContain('href="/sso/start"');
    expect((await instance.get("/setup")).status).toBe(404);
  });

  it("shows the Recovery Kit after the first sign-in until an Admin confirms it was saved, then no longer", async () => {
    const cookie = await signIn();
    expect((await instance.get("/admin", { cookie })).headers.get("location")).toBe("/admin/recovery-kit");
    const masterKey = instance.app.recoveryKit.contents().masterKey;
    expect(await (await instance.get("/admin/recovery-kit", { cookie })).text()).toContain(masterKey);

    await instance.post("/admin/recovery-kit/confirm", { saved: "yes" }, { cookie });
    await instance.restart();

    const areas = await instance.get("/admin", { cookie: await signIn() });
    expect(areas.status).toBe(200);
    const html = await areas.text();
    expect(html).not.toContain(masterKey);
    expect(html).not.toContain("/admin/recovery-kit/confirm");
  });

  it("opens the Admin area with default settings that can be changed there", async () => {
    const cookie = await signIn();
    await instance.post("/admin/recovery-kit/confirm", { saved: "yes" }, { cookie });

    for (const path of ["/admin/family-members", "/admin/agendas", "/admin/sources", "/admin/llm", "/admin/display"])
      expect((await instance.get(path, { cookie })).status).toBe(200);
    expect(await instance.app.languages.current()).toMatchObject({
      language: "en",
      ocrEnabled: true,
      ocrLanguages: [{ language: "eng" }],
    });

    expect((await instance.post("/admin/display", { language: "de" }, { cookie })).status).toBe(303);
    await instance.post("/admin/llm/ocr/enabled", {}, { cookie });
    expect(await instance.app.languages.current()).toMatchObject({ language: "de", ocrEnabled: false });
  });
});
