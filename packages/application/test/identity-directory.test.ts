import { describe, expect, it } from "vitest";
import { parseIdentityDirectorySettings } from "../src";

const complete = { api: "logto", endpoint: "https://id.example.org/", clientId: "m2m", clientSecret: "s3cret" };

describe("the settings of the Identity Directory", () => {
  it("are none when every one is absent or empty", () => {
    expect(parseIdentityDirectorySettings({})).toEqual({ ok: true, settings: null });
    expect(parseIdentityDirectorySettings({ api: "", endpoint: "", clientId: "", clientSecret: "" })).toEqual({ ok: true, settings: null });
  });

  it("are read when complete, the endpoint without a trailing slash", () => {
    expect(parseIdentityDirectorySettings(complete)).toEqual({
      ok: true,
      settings: { api: "logto", endpoint: "https://id.example.org", clientId: "m2m", clientSecret: "s3cret" },
    });
    expect(parseIdentityDirectorySettings({ ...complete, endpoint: "http://logto:3001/base//" })).toMatchObject({ settings: { endpoint: "http://logto:3001/base" } });
  });

  it("name the first one that is missing or wrong", () => {
    expect(parseIdentityDirectorySettings({ ...complete, api: undefined })).toEqual({ ok: false, problem: "invalid-api" });
    expect(parseIdentityDirectorySettings({ ...complete, api: "keycloak" })).toEqual({ ok: false, problem: "invalid-api" });
    expect(parseIdentityDirectorySettings({ ...complete, endpoint: undefined })).toEqual({ ok: false, problem: "invalid-endpoint" });
    expect(parseIdentityDirectorySettings({ ...complete, endpoint: "id.example.org" })).toEqual({ ok: false, problem: "invalid-endpoint" });
    expect(parseIdentityDirectorySettings({ ...complete, endpoint: "ftp://id.example.org" })).toEqual({ ok: false, problem: "invalid-endpoint" });
    expect(parseIdentityDirectorySettings({ ...complete, endpoint: "https://id.example.org/?x=1" })).toEqual({ ok: false, problem: "invalid-endpoint" });
    expect(parseIdentityDirectorySettings({ ...complete, endpoint: "https://id.example.org/#x" })).toEqual({ ok: false, problem: "invalid-endpoint" });
    expect(parseIdentityDirectorySettings({ ...complete, clientId: "" })).toEqual({ ok: false, problem: "client-id-missing" });
    expect(parseIdentityDirectorySettings({ ...complete, clientSecret: "" })).toEqual({ ok: false, problem: "client-secret-missing" });
    expect(parseIdentityDirectorySettings({ clientSecret: "s3cret" })).toEqual({ ok: false, problem: "invalid-api" });
  });
});
