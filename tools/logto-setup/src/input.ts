import { withoutTrailingSlash } from "./management-api";
import type { SetupInput, SmtpSettings } from "./setup";

type Env = Record<string, string | undefined>;

/** The colours of the Admin area (`--hearth` in tokens.css), light and dark. */
export const brandColors = { primaryColor: "#bb4f29", darkPrimaryColor: "#e8875f" };

/** Where the setup reaches Logto's Management API from inside the Compose network. */
// Inside the Compose network, which carries no TLS.
// eslint-disable-next-line sonarjs/no-clear-text-protocols
export const defaultApiEndpoint = "http://logto:3001";

export interface SetupEnvironment {
  apiEndpoint: string;
  appId: string;
  appSecret: string;
  input: SetupInput;
}

/** Reads the setup's settings from the environment; throws naming every variable that is missing. */
export function readSetupEnvironment(env: Env, files: { customCss: string; logoDataUrl: string }): SetupEnvironment {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };
  const appId = required("LOGTO_M2M_APP_ID");
  const appSecret = required("LOGTO_M2M_APP_SECRET");
  const publicEndpoint = required("LOGTO_ENDPOINT");
  const firstAdmin = { username: required("FIRST_ADMIN_USERNAME"), email: required("FIRST_ADMIN_EMAIL") };
  const redirectUris = readRedirectUris(env, missing);
  const smtp = readSmtp(env, missing);
  if (missing.length > 0) throw new Error(`Missing: ${missing.join(", ")}`);

  return {
    apiEndpoint: env.LOGTO_API_ENDPOINT ?? defaultApiEndpoint,
    appId,
    appSecret,
    input: {
      publicEndpoint,
      redirectUris,
      adminRole: env.OIDC_REQUIRED_GROUP ?? "homelab-admin",
      firstAdmin,
      // Logto's sign-in pages load images only over https or as data: URLs.
      branding: { logoUrl: env.LOGTO_LOGO_URL ?? files.logoDataUrl, ...brandColors, customCss: files.customCss },
      ...(smtp ? { smtp } : {}),
      suppliedMode: env.CONTEXT_MODE === "supplied",
    },
  };
}

/** `<PUBLIC_URL>/sso/callback`, and in supplied mode `OIDC_CALLBACK_URL`; at least one. */
function readRedirectUris(env: Env, missing: string[]): string[] {
  const fromPublicUrl = env.PUBLIC_URL ? [`${withoutTrailingSlash(env.PUBLIC_URL)}/sso/callback`] : [];
  const redirectUris = [...fromPublicUrl, ...(env.OIDC_CALLBACK_URL ? [env.OIDC_CALLBACK_URL] : [])];
  if (redirectUris.length === 0) missing.push("PUBLIC_URL or OIDC_CALLBACK_URL");
  return redirectUris;
}

/** SMTP only when SMTP_HOST is set; it then needs SMTP_FROM. */
function readSmtp(env: Env, missing: string[]): SmtpSettings | undefined {
  if (!env.SMTP_HOST) return undefined;
  if (!env.SMTP_FROM) missing.push("SMTP_FROM");
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 587),
    ...(env.SMTP_USER ? { user: env.SMTP_USER, password: env.SMTP_PASSWORD ?? "" } : {}),
    fromEmail: env.SMTP_FROM ?? "",
  };
}
