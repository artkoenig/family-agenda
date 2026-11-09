/**
 * The names and ports the generated compose file, the api and the egress proxies agree on
 * (ADR-0001), kept in one place.
 */

/** Where the api serves the allowlists, on a port compose does not publish. */
export const allowlistPort = 3001;
/** Where each egress proxy takes CONNECT requests. */
export const proxyPort = 3128;

/** The compose service of Source Type `id`'s plugin, such as `plugin-demo`. */
export const pluginServiceOf = (id: string) => `plugin-${id}`;

/** The egress proxy of container `service`, and the internal network it shares with that container only. */
export const proxyOf = (service: string) => `${service}-egress`;

/** The `.env` variable holding the token with which `service`'s proxy fetches its allowlist. */
export const tokenVariableOf = (service: string) => `${service.replaceAll("-", "_").toUpperCase()}_EGRESS_TOKEN`;

/** The URL the proxy of `service` fetches its allowlist from. */
export const allowlistUrlOf = (service: string) => `http://api:${allowlistPort}/egress/${service}`;
