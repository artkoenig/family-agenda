import { healthResponse } from "@family-agenda/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";

describe("health over HTTP", () => {
  let instance: HttpTestInstance;
  beforeEach(async () => {
    instance = await bootHttpForTest();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("answers without a session, even before the first Admin exists", async () => {
    const response = await instance.get("/api/health");

    expect(response.status).toBe(200);
    expect(healthResponse.parse(await response.json())).toEqual({ status: "ok" });
  });
});
