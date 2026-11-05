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

  it("signs the first Admin in, shows the Recovery Kit, and the page is gone afterwards", async () => {
    const created = await instance.post("/setup", {
      email: "anna@example.org",
      password: "correct horse battery",
    });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/admin/recovery-kit");

    const adminArea = await instance.get("/admin/recovery-kit", { cookie: sessionCookieOf(created) });
    expect(adminArea.status).toBe(200);
    expect(await adminArea.text()).toContain("anna@example.org");

    expect((await instance.get("/setup")).status).toBe(404);
    expect(
      (await instance.post("/setup", { email: "mallory@example.org", password: "correct horse battery" }))
        .status,
    ).toBe(404);
  });

  it("asks for the Family Language, memberIds from the browser's languages", async () => {
    const selected = async (acceptLanguage?: string) => {
      const page = await (await instance.get("/setup", acceptLanguage ? { headers: { "accept-language": acceptLanguage } } : {})).text();
      return /<option value="(\w+)" selected=""/.exec(page)?.[1];
    };

    expect(await selected("de-DE,de;q=0.9,en;q=0.8")).toBe("de");
    expect(await selected("fr-FR,fr;q=0.9,de;q=0.7,en;q=0.5")).toBe("de");
    expect(await selected("en-US,de;q=0.5")).toBe("en");
    expect(await selected("fr-FR")).toBe("en");
    expect(await selected()).toBe("en");
  });

  it("sets the Family Language with the first Admin", async () => {
    await instance.post("/setup", { email: "anna@example.org", password: "correct horse battery", language: "de" });

    expect((await instance.app.languages.current()).language).toBe("de");
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
