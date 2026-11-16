import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, signedInCookie, type HttpTestInstance } from "../support/http";

describe("Admin area over HTTP", () => {
  let instance: HttpTestInstance;
  beforeEach(async () => {
    instance = await bootHttpForTest();
    await instance.app.recoveryKit.confirm();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("redirects Admin pages to sign-in without a session", async () => {
    for (const path of ["/admin", "/admin/agendas"]) {
      const response = await instance.get(path);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/sign-in");
    }
    const post = await instance.post("/admin/family-members", { name: "Mia" });
    expect(post.headers.get("location")).toBe("/admin/sign-in");
    const withUnknownSession = await instance.get("/admin", { cookie: "fb_session=forged" });
    expect(withUnknownSession.headers.get("location")).toBe("/admin/sign-in");
  });

  it("signs out again, ending the session", async () => {
    const page = await instance.get("/admin/sign-in");
    expect(await page.text()).toContain("Sign in");

    const cookie = await signedInCookie(instance);
    expect((await instance.get("/admin", { cookie })).status).toBe(200);

    const signedOut = await instance.post("/admin/sign-out", {}, { cookie });
    expect(signedOut.headers.get("location")).toBe("/admin/sign-in");
    expect((await instance.get("/admin", { cookie })).status).toBe(302);
  });

  it("serves htmx to its pages", async () => {
    const page = await (await instance.get("/admin/sign-in")).text();
    expect(page).toContain('<script src="/static/htmx.min.js"');

    const script = await instance.get("/static/htmx.min.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).toContain("htmx");
  });
});
