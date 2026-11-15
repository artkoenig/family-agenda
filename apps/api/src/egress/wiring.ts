/**
 * The names and ports the generated compose file, the core and the egress proxies agree on
 * (ADR-0001), kept in one place.
 */

/** Where each egress proxy takes CONNECT requests. */
export const proxyPort = 3128;

/** The compose service of Source Type `id`'s plugin, such as `plugin-demo`. */
export const pluginServiceOf = (id: string) => `plugin-${id}`;

/** The egress proxy of container `service`, and the internal network it shares with that container only. */
export const proxyOf = (service: string) => `${service}-egress`;

/** The `.env` variable holding the key the core signs the tickets of plugin calls with, which the proxies check. */
export const ticketKeyVariable = "EGRESS_TICKET_KEY";


/**
 * The `.env` variable holding the token the Triggered operations require, generated with the ticket
 * key: plugin containers share a network with the `api`, so its unpublished port is no protection.
 */
export const triggerTokenVariable = "TRIGGER_TOKEN";
