import { withoutTrailingSlash } from "./management-api";
import type { RegistrationSettings, SetupInput, SmtpSettings } from "./setup";

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
  const firstAdmin = readFirstAdmin(env, required);
  const redirectUris = readRedirectUris(env, missing);
  const smtp = readSmtp(env, missing);
  const registration = readRegistration(env, missing, { endpoint: publicEndpoint, clientId: appId, clientSecret: appSecret });
  if (missing.length > 0) throw new Error(`Missing: ${missing.join(", ")}`);

  return {
    apiEndpoint: env.LOGTO_API_ENDPOINT ?? defaultApiEndpoint,
    appId,
    appSecret,
    input: {
      publicEndpoint,
      redirectUris,
      adminRole: env.OIDC_REQUIRED_GROUP ?? "homelab-admin",
      ...firstAdmin,
      // Logto's sign-in pages load images only over https or as data: URLs.
      branding: { logoUrl: env.LOGTO_LOGO_URL ?? files.logoDataUrl, ...brandColors, customCss: files.customCss },
      ...(smtp ? { smtp } : {}),
      suppliedMode: env.CONTEXT_MODE === "supplied",
      ...registration,
    },
  };
}

/** The first Admin, unless registration creates them because it can open (ADR-0010). */
function readFirstAdmin(env: Env, required: (name: string) => string): { firstAdmin?: NonNullable<SetupInput["firstAdmin"]> } {
  if (env.IDP_MANAGEMENT_API && env.SMTP_HOST && !env.FIRST_ADMIN_USERNAME) return {};
  return { firstAdmin: { username: required("FIRST_ADMIN_USERNAME"), email: required("FIRST_ADMIN_EMAIL") } };
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

/**
 * Registration only when `IDP_MANAGEMENT_API` is set (ADR-0010). The core manages Logto with
 * `IDP_MANAGEMENT_*`, by default the setup's own endpoint and machine-to-machine app, and receives
 * events at `IDP_EVENTS_URL`, by default `<PUBLIC_URL>/idp/events`.
 */
function readRegistration(env: Env, missing: string[], defaults: RegistrationSettings["management"]): { registration?: RegistrationSettings } {
  if (!env.IDP_MANAGEMENT_API) return {};
  if (env.IDP_MANAGEMENT_API !== "logto") throw new Error("IDP_MANAGEMENT_API must be logto, the only management API there is");
  return { registration: { eventsUrl: readEventsUrl(env, missing), management: readManagement(env, defaults) } };
}

function readEventsUrl(env: Env, missing: string[]): string {
  if (env.IDP_EVENTS_URL) return env.IDP_EVENTS_URL;
  if (env.PUBLIC_URL) return `${withoutTrailingSlash(env.PUBLIC_URL)}/idp/events`;
  missing.push("IDP_EVENTS_URL or PUBLIC_URL");
  return "";
}

function readManagement(env: Env, defaults: RegistrationSettings["management"]): RegistrationSettings["management"] {
  return {
    endpoint: env.IDP_MANAGEMENT_ENDPOINT ?? defaults.endpoint,
    clientId: env.IDP_MANAGEMENT_CLIENT_ID ?? defaults.clientId,
    clientSecret: env.IDP_MANAGEMENT_CLIENT_SECRET ?? defaults.clientSecret,
  };
}
