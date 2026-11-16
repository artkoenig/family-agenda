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
    expect(setup.input).toMatchObject({ redirectUris: ["https://sign-in.example.org/sso/callback"], suppliedMode: true, adminRole: "parents", branding: { logoUrl: "https://example.org/logo.png" } });
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
});
