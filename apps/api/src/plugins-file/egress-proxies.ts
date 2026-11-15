import { pluginServiceOf, proxyOf, proxyPort, ticketKeyVariable } from "../egress/wiring";
import type { Plugin, PluginsFile } from "./schema";

type Service = Record<string, unknown>;

/**
 * A container that gets an egress proxy, its declared egress `hosts`, and the other containers of
 * its plugin, which it reaches directly. The plugin's own container (`own`) is called by the core,
 * whose tickets its proxy checks; a companion's proxy allows its declared hosts alone, as the core
 * never calls it.
 */
export type ProxiedContainer = { service: string; siblings: string[]; hosts: string[]; own: boolean };

/** The containers of `plugin` with an egress proxy: the plugin's own, and each companion with egress hosts. */
export function proxiedContainersOf(plugin: Plugin): ProxiedContainer[] {
  const own = pluginServiceOf(plugin.id);
  const companionOf = (name: string) => `${own}-${name}`;
  const all = [own, ...plugin.companions.map((companion) => companionOf(companion.name))];
  const siblingsOf = (service: string) => all.filter((other) => other !== service);
  return [
    { service: own, siblings: siblingsOf(own), hosts: plugin.egress, own: true },
    ...plugin.companions
      .filter((companion) => companion.egress.length > 0)
      .map((companion) => ({ service: companionOf(companion.name), siblings: siblingsOf(companionOf(companion.name)), hosts: companion.egress, own: false })),
  ];
}

/** The proxied containers of the whole file. */
export const allProxiedContainersOf = (file: PluginsFile) => file.plugins.flatMap(proxiedContainersOf);

/** The `.env` variable of the ticket key, which the generator fills like a database password, if there are plugins. */
export const ticketKeyVariablesOf = (file: PluginsFile) => (file.plugins.length > 0 ? [ticketKeyVariable] : []);

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
 * The egress proxy of `container` (ADR-0001), and what its container adds. The proxy of a plugin's
 * own container checks the ticket of each connection and allows the plugin's declared hosts and
 * those of the ticket's Source; a companion's allows its declared hosts. The proxy sits on the
 * Instance's default network, which reaches the internet, and on an internal network
 * shared with that container alone. The container gets that network and the proxy in its
 * environment, but reaches its siblings directly. Without the proxy it reaches nothing outside.
 */
export function egressProxyOf({ service, siblings, hosts, own }: ProxiedContainer, image: string): {
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
      environment: {
        EGRESS_HOSTS: hosts.join(";"),
        ...(own ? { EGRESS_PLUGIN: service, EGRESS_TICKET_KEY: `\${${ticketKeyVariable}}` } : {}),
        PORT: String(proxyPort),
      },
      networks: ["default", name],
      mem_limit: "128m",
    },
    container: {
      network: name,
      environment: { HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url, NO_PROXY: noProxy, no_proxy: noProxy },
    },
  };
}
