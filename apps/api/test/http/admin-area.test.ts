import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";

const password = "correct horse battery";

describe("Admin area over HTTP", () => {
  let instance: HttpTestInstance;
  beforeEach(async () => {
    instance = await bootHttpForTest();
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
  });
  afterEach(async () => {
    await instance.close();
  });

  const signIn = async (email = "anna@example.org", pw = password) => {
    const response = await instance.post("/admin/sign-in", { email, password: pw });
    expect(response.status).toBe(303);
    return sessionCookieOf(response);
  };

  it("redirects Admin pages to sign-in without a session", async () => {
    for (const path of ["/admin", "/admin/admins"]) {
      const response = await instance.get(path);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/sign-in");
    }
    const post = await instance.post("/admin/admins", { email: "x@example.org", password });
    expect(post.headers.get("location")).toBe("/admin/sign-in");
    const withUnknownSession = await instance.get("/admin", { cookie: "fb_session=forged" });
    expect(withUnknownSession.headers.get("location")).toBe("/admin/sign-in");
  });

  it("signs in with email and password, and out again", async () => {
    const page = await instance.get("/admin/sign-in");
    expect(await page.text()).toContain("Sign in");

    const cookie = await signIn();
    expect((await instance.get("/admin", { cookie })).status).toBe(200);

    const signedOut = await instance.post("/admin/sign-out", {}, { cookie });
    expect(signedOut.headers.get("location")).toBe("/admin/sign-in");
    expect((await instance.get("/admin", { cookie })).status).toBe(302);
  });

  it("refuses a wrong password", async () => {
    const response = await instance.post("/admin/sign-in", {
      email: "anna@example.org",
      password: "wrong password!!",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("Wrong email or password");
  });

  it("creates a further Admin and resets their password", async () => {
    const cookie = await signIn();

    const created = await instance.post(
      "/admin/admins",
      { email: "ben@example.org", password: "another long password" },
      { cookie },
    );
    expect(created.status).toBe(303);
    const benCookie = await signIn("ben@example.org", "another long password");

    const list = await (await instance.get("/admin/admins", { cookie })).text();
    expect(list).toContain("ben@example.org");
    // Their row opens their dialog, where the new password is set.
    const benId = /href="\/admin\/admins\/([0-9a-f-]{36})"/.exec(list)?.[1];
    expect(benId).toBeDefined();
    expect(await (await instance.get(`/admin/admins/${benId}`, { cookie })).text()).toContain(`action="/admin/admins/${benId}/password"`);

    const reset = await instance.post(
      `/admin/admins/${benId}/password`,
      { password: "a brand new password" },
      { cookie },
    );
    expect(reset.status).toBe(303);
    expect((await instance.get("/admin", { cookie: benCookie })).status).toBe(302);
    await signIn("ben@example.org", "a brand new password");
  });

  it("shows why a further Admin cannot be created", async () => {
    const cookie = await signIn();

    const response = await instance.post(
      "/admin/admins",
      { email: "anna@example.org", password },
      { cookie },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("already has an Admin account");
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
