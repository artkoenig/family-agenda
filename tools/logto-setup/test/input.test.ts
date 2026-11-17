import { describe, expect, it } from "vitest";
import { defaultApiEndpoint, readSetupEnvironment } from "../src/input";

const files = { customCss: "body {}", logoDataUrl: "data:image/svg+xml;base64,PHN2Zy8+" };
const env = {
  LOGTO_M2M_APP_ID: "m2m",
  LOGTO_M2M_APP_SECRET: "m2m-secret",
  LOGTO_ENDPOINT: "https://sign-in.example.org",
  FIRST_ADMIN_USERNAME: "parent",
  FIRST_ADMIN_EMAIL: "parent@example.org",
  PUBLIC_URL: "https://agenda.example.org/",
};

describe("reading the setup's settings", () => {
  it("derives the redirect URI from PUBLIC_URL and uses the defaults", () => {
    const setup = readSetupEnvironment(env, files);

    expect(setup).toMatchObject({ apiEndpoint: defaultApiEndpoint, appId: "m2m", appSecret: "m2m-secret" });
    expect(setup.input).toEqual({
      publicEndpoint: "https://sign-in.example.org",
      redirectUris: ["https://agenda.example.org/sso/callback"],
      postLogoutRedirectUris: ["https://agenda.example.org/admin/sign-in"],
      adminRole: "homelab-admin",
      firstAdmin: { username: "parent", email: "parent@example.org" },
      branding: { logoUrl: files.logoDataUrl, primaryColor: "#bb4f29", darkPrimaryColor: "#e8875f", customCss: "body {}" },
      suppliedMode: false,
    });
  });

  it("takes OIDC_CALLBACK_URL in supplied mode, and the overrides", () => {
    const supplied: Record<string, string | undefined> = { ...env, PUBLIC_URL: undefined };
    const setup = readSetupEnvironment(
      { ...supplied, CONTEXT_MODE: "supplied", OIDC_CALLBACK_URL: "https://sign-in.example.org/sso/callback", LOGTO_API_ENDPOINT: "http://localhost:3001", LOGTO_LOGO_URL: "https://example.org/logo.png", OIDC_REQUIRED_GROUP: "parents" },
      files,
    );

    expect(setup.apiEndpoint).toBe("http://localhost:3001");
    expect(setup.input).toMatchObject({ redirectUris: ["https://sign-in.example.org/sso/callback"], postLogoutRedirectUris: ["https://sign-in.example.org/sso/callback"], suppliedMode: true, adminRole: "parents", branding: { logoUrl: "https://example.org/logo.png" } });
  });

  it("reads SMTP only when SMTP_HOST is set", () => {
    expect(readSetupEnvironment(env, files).input.smtp).toBeUndefined();
    expect(readSetupEnvironment({ ...env, SMTP_HOST: "mail.example.org", SMTP_FROM: "agenda@example.org" }, files).input.smtp).toEqual({ host: "mail.example.org", port: 587, fromEmail: "agenda@example.org" });
    expect(readSetupEnvironment({ ...env, SMTP_HOST: "mail.example.org", SMTP_PORT: "465", SMTP_USER: "agenda", SMTP_PASSWORD: "pw", SMTP_FROM: "a@example.org" }, files).input.smtp).toEqual({ host: "mail.example.org", port: 465, user: "agenda", password: "pw", fromEmail: "a@example.org" });
    expect(readSetupEnvironment({ ...env, SMTP_HOST: "mail.example.org", SMTP_USER: "agenda", SMTP_FROM: "a@example.org" }, files).input.smtp).toMatchObject({ password: "" });
  });

  it("names every missing variable at once", () => {
    expect(() => readSetupEnvironment({ SMTP_HOST: "mail.example.org", LOGTO_ENDPOINT: " " }, files)).toThrow(
      "Missing: LOGTO_M2M_APP_ID, LOGTO_M2M_APP_SECRET, LOGTO_ENDPOINT, FIRST_ADMIN_USERNAME, FIRST_ADMIN_EMAIL, PUBLIC_URL or OIDC_CALLBACK_URL, SMTP_FROM",
    );
  });

  describe("registration (ADR-0010)", () => {
    const smtpEnv = { SMTP_HOST: "mail.example.org", SMTP_FROM: "agenda@example.org" };

    it("is off without IDP_MANAGEMENT_API", () => {
      expect(readSetupEnvironment({ ...env, ...smtpEnv }, files).input.registration).toBeUndefined();
    });

    it("reaches the core's events below PUBLIC_URL and manages through the setup's own app by default", () => {
      const setup = readSetupEnvironment({ ...env, ...smtpEnv, IDP_MANAGEMENT_API: "logto" }, files);

      expect(setup.input.registration).toEqual({
        eventsUrl: "https://agenda.example.org/idp/events",
        management: { endpoint: "https://sign-in.example.org", clientId: "m2m", clientSecret: "m2m-secret" },
      });
    });

    it("takes the core's own management client, endpoint and events address", () => {
      const setup = readSetupEnvironment(
        { ...env, ...smtpEnv, IDP_MANAGEMENT_API: "logto", IDP_MANAGEMENT_ENDPOINT: "http://logto:3001", IDP_MANAGEMENT_CLIENT_ID: "core", IDP_MANAGEMENT_CLIENT_SECRET: "core-secret", IDP_EVENTS_URL: "https://hooks.example.org/idp/events" },
        files,
      );

      expect(setup.input.registration).toEqual({
        eventsUrl: "https://hooks.example.org/idp/events",
        management: { endpoint: "http://logto:3001", clientId: "core", clientSecret: "core-secret" },
      });
    });

    it("needs no first Admin when registration creates the Family, but still one without SMTP", () => {
      const noAdmin = { ...env, FIRST_ADMIN_USERNAME: undefined, FIRST_ADMIN_EMAIL: undefined, IDP_MANAGEMENT_API: "logto" };

      expect(readSetupEnvironment({ ...noAdmin, ...smtpEnv }, files).input.firstAdmin).toBeUndefined();
      expect(() => readSetupEnvironment(noAdmin, files)).toThrow("Missing: FIRST_ADMIN_USERNAME, FIRST_ADMIN_EMAIL");
    });

    it("refuses another management API and needs an events address", () => {
      expect(() => readSetupEnvironment({ ...env, IDP_MANAGEMENT_API: "keycloak" }, files)).toThrow("IDP_MANAGEMENT_API must be logto");
      expect(() => readSetupEnvironment({ ...env, ...smtpEnv, PUBLIC_URL: undefined, OIDC_CALLBACK_URL: "https://x.example.org/sso/callback", IDP_MANAGEMENT_API: "logto" }, files)).toThrow(
        "Missing: IDP_EVENTS_URL or PUBLIC_URL",
      );
    });
  });
});
