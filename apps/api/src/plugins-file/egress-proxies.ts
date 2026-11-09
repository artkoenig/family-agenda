import { allowlistUrlOf, pluginServiceOf, proxyOf, proxyPort, tokenVariableOf } from "../egress/wiring";
import type { Plugin, PluginsFile } from "./schema";

type Service = Record<string, unknown>;

/** A container that gets an egress proxy, and the other containers of its plugin, which it reaches directly. */
export type ProxiedContainer = { service: string; siblings: string[] };

/** The containers of `plugin` with an egress proxy: the plugin's own, and each companion with egress hosts. */
export function proxiedContainersOf(plugin: Plugin): ProxiedContainer[] {
  const own = pluginServiceOf(plugin.id);
  const companionOf = (name: string) => `${own}-${name}`;
  const all = [own, ...plugin.companions.map((companion) => companionOf(companion.name))];
  const proxied = [own, ...plugin.companions.filter((companion) => companion.egress.length > 0).map((companion) => companionOf(companion.name))];
  return proxied.map((service) => ({ service, siblings: all.filter((other) => other !== service) }));
}

/** The proxied containers of the whole file. */
export const allProxiedContainersOf = (file: PluginsFile) => file.plugins.flatMap(proxiedContainersOf);

/** The `.env` variable of each proxy's token, which the generator fills like a database password. */
export const tokenVariablesOf = (file: PluginsFile) => allProxiedContainersOf(file).map(({ service }) => tokenVariableOf(service));

/** `PLUGIN_EGRESS_TOKENS` for the api: each container with the token its proxy presents. */
export const egressTokensOf = (file: PluginsFile) =>
  allProxiedContainersOf(file)
    .map(({ service }) => `${service}=\${${tokenVariableOf(service)}}`)
    .join(",");

/**
 * The image the egress proxies run: the core image of the release that generates the file, as
 * compose.yaml names it, so `FAMILY_AGENDA_VERSION` moves them along. For `dev`, the local build
 * of compose.dev.yaml, or the one `EGRESS_PROXY_IMAGE` names, such as a preview's.
 */
export function proxyImageOf(version: string): string {
  if (version === "dev") return "${EGRESS_PROXY_IMAGE:-family-agenda:local}";
  const release = /^\d+\.\d+\.\d+$/.test(version) ? version : "main";
  return `ghcr.io/artkoenig/family-agenda:\${FAMILY_AGENDA_VERSION:-${release}}`;
}

/**
 * The egress proxy of `container` (ADR-0001), and what its container adds. The proxy sits on the
 * Instance's default network, which reaches the internet and the api, and on an internal network
 * shared with that container alone. The container gets that network and the proxy in its
 * environment, but reaches its siblings directly. Without the proxy it reaches nothing outside.
 */
export function egressProxyOf({ service, siblings }: ProxiedContainer, image: string): {
  name: string;
  proxy: Service;
  container: { network: string; environment: Record<string, string> };
} {
  const name = proxyOf(service);
  const url = `http://${name}:${proxyPort}`;
  const noProxy = ["localhost", "127.0.0.1", ...siblings].join(",");
  return {
    name,
    proxy: {
      image,
      restart: "unless-stopped",
      command: ["node", "--import", "tsx", "src/egress-proxy-main.ts"],
      environment: { EGRESS_ALLOWLIST_URL: allowlistUrlOf(service), EGRESS_TOKEN: `\${${tokenVariableOf(service)}}`, PORT: String(proxyPort) },
      networks: ["default", name],
      mem_limit: "128m",
    },
    container: {
      network: name,
      environment: { HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url, NO_PROXY: noProxy, no_proxy: noProxy },
    },
  };
}
