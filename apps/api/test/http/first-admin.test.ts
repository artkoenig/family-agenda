import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";

describe("first Admin over HTTP", () => {
  let instance: HttpTestInstance;
  beforeEach(async () => {
    instance = await bootHttpForTest();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("sends the first request on an Instance without Admins to creating the first Admin", async () => {
    for (const path of ["/", "/admin", "/admin/sign-in"]) {
      const response = await instance.get(path);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/setup");
    }
    const page = await instance.get("/setup");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Create the first Admin");
  });

  it("signs the first Admin in, and the page is gone afterwards", async () => {
    const created = await instance.post("/setup", {
      email: "anna@example.org",
      password: "correct horse battery",
    });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/admin");

    const adminArea = await instance.get("/admin", { cookie: sessionCookieOf(created) });
    expect(adminArea.status).toBe(200);
    expect(await adminArea.text()).toContain("anna@example.org");

    expect((await instance.get("/setup")).status).toBe(404);
    expect(
      (await instance.post("/setup", { email: "mallory@example.org", password: "correct horse battery" }))
        .status,
    ).toBe(404);
  });

  it("shows what is wrong with the form", async () => {
    const response = await instance.post("/setup", { email: "anna@example.org", password: "short" });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("at least 12 characters");
  });

  it("refuses a form posted from another origin", async () => {
    const response = await instance.post(
      "/setup",
      { email: "mallory@example.org", password: "correct horse battery" },
      { headers: { origin: "http://evil.example" } },
    );

    expect(response.status).toBe(403);
  });
});
