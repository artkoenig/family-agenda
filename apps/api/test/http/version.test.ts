import { healthResponse } from "@family-agenda/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { bootHttpForTest, signedInCookie, type HttpTestInstance } from "../support/http";

describe("the version of a running Instance", () => {
  let instance: HttpTestInstance;
  afterEach(async () => {
    await instance.close();
  });

  it("is named by the health check, as a development build when nothing sets it", async () => {
    instance = await bootHttpForTest();

    const response = await instance.get("/api/health");

    expect(healthResponse.parse(await response.json())).toEqual({ status: "ok", version: "dev" });
  });

  it("is the one the image was built with, in the health check and in the Admin area", async () => {
    instance = await bootHttpForTest({ version: "0.3.1" });
    await instance.app.recoveryKit.confirm();

    const health = await instance.get("/api/health");
    const admin = await instance.get("/admin", { cookie: await signedInCookie(instance) });

    expect(healthResponse.parse(await health.json()).version).toBe("0.3.1");
    expect(await admin.text()).toContain("Version 0.3.1");
  });
});
