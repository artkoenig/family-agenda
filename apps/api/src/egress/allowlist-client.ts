import type { AllowlistFetch } from "./proxy";
import { proxyPort } from "./wiring";

/** Fetches a proxy's allowlist from the api with its token; rejects on any answer but a list of hosts. */
export function allowlistFetcher(url: string, token: string, fetchFn: typeof fetch = fetch): AllowlistFetch {
  return async () => {
    const response = await fetchFn(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`the core answered ${response.status}`);
    const body = (await response.json()) as { hosts?: unknown };
    const hosts = body.hosts;
    if (!Array.isArray(hosts) || !hosts.every((host): host is string => typeof host === "string")) throw new Error("the core sent no list of hosts");
    return hosts;
  };
}

/** The proxy's settings from its environment, as compose.plugins.yaml sets them. */
export function proxySettingsOf(env: NodeJS.ProcessEnv): { url: string; token: string; port: number } {
  const url = env.EGRESS_ALLOWLIST_URL;
  const token = env.EGRESS_TOKEN;
  if (!url) throw new Error("EGRESS_ALLOWLIST_URL is not set");
  if (!token) throw new Error("EGRESS_TOKEN is not set");
  return { url, token, port: Number(env.PORT ?? proxyPort) };
}
