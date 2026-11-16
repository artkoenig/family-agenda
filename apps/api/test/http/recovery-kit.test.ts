import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, signedInCookie, type HttpTestInstance } from "../support/http";

describe("Recovery Kit over HTTP", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  beforeEach(async () => {
    instance = await bootHttpForTest();
    cookie = await signedInCookie(instance);
  });
  afterEach(async () => {
    await instance.close();
  });

  const masterKey = () => instance.app.recoveryKit.contents().masterKey;

  it("is shown to the first Admin who signs in, printable and downloadable", async () => {
    expect((await instance.get("/admin", { cookie })).headers.get("location")).toBe("/admin/recovery-kit");
    const page = await instance.get("/admin/recovery-kit", { cookie });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain(masterKey());
    expect(html).toContain("window.print()");
    expect(html).toContain('href="/admin/recovery-kit/download"');

    const download = await instance.get("/admin/recovery-kit/download", { cookie });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(await download.text()).toContain(masterKey());
  });

  it("keeps the Admin area unreachable until saving the kit is confirmed", async () => {
    for (const path of ["/admin", "/admin/agendas"]) {
      const response = await instance.get(path, { cookie });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/recovery-kit");
    }
    const adding = await instance.post("/admin/family-members", { name: "Mia" }, { cookie });
    expect(adding.headers.get("location")).toBe("/admin/recovery-kit");

    const unchecked = await instance.post("/admin/recovery-kit/confirm", {}, { cookie });
    expect(unchecked.status).toBe(400);
    expect(await unchecked.text()).toContain("Confirm that you have saved the Recovery Kit");
    expect((await instance.get("/admin", { cookie })).status).toBe(302);

    const confirmed = await instance.post("/admin/recovery-kit/confirm", { saved: "yes" }, { cookie });
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get("location")).toBe("/admin");
    expect((await instance.get("/admin", { cookie })).status).toBe(200);
  });

  it("can be shown again to a signed-in Admin once confirmed", async () => {
    await instance.post("/admin/recovery-kit/confirm", { saved: "yes" }, { cookie });

    const page = await instance.get("/admin/recovery-kit", { cookie });

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(masterKey());
    expect(html).not.toContain('action="/admin/recovery-kit/confirm"');
  });

  it("requires signing in to see the kit", async () => {
    for (const path of ["/admin/recovery-kit", "/admin/recovery-kit/download"]) {
      const response = await instance.get(path);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/sign-in");
    }
    const confirming = await instance.post("/admin/recovery-kit/confirm", { saved: "yes" });
    expect(confirming.headers.get("location")).toBe("/admin/sign-in");
    expect(await instance.app.recoveryKit.isConfirmed()).toBe(false);
  });
});
