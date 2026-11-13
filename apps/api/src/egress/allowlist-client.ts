import type { AllowlistFetch } from "./proxy";
import { verifyTicket } from "./ticket";
import { proxyPort } from "./wiring";

/** Where a plugin's own proxy fetches its allowlist, and the key it checks tickets with. */
export type TicketSettings = { url: string; ticketKey: string };

/**
 * The allowlist of a plugin's own proxy: fetched from the api for each connection, with the ticket
 * the plugin call presented. A connection without a ticket, or with one that is expired or not
 * signed with the ticket key, is refused before asking; so is one the api answers 401 or 403 for.
 * Rejects on any other answer but a list of hosts.
 */
export function ticketAllowlist({ url, ticketKey }: TicketSettings, fetchFn: typeof fetch = fetch, now: () => number = Date.now): AllowlistFetch {
  return async (ticket) => {
    if (ticket === null || verifyTicket(ticketKey, ticket, now()) === null) return null;
    const response = await fetchFn(url, { headers: { authorization: `Bearer ${ticket}` }, signal: AbortSignal.timeout(5000) });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error(`the core answered ${response.status}`);
    const body = (await response.json()) as { hosts?: unknown };
    const hosts = body.hosts;
    if (!Array.isArray(hosts) || !hosts.every((host): host is string => typeof host === "string")) throw new Error("the core sent no list of hosts");
    return hosts;
  };
}

/** The allowlist of a companion's proxy: its declared hosts, for any connection; the core never calls a companion. */
export function staticAllowlist(hosts: string[]): AllowlistFetch {
  return () => Promise.resolve(hosts);
}

/**
 * The proxy's settings from its environment, as compose.plugins.yaml sets them: for a plugin's own
 * container, `EGRESS_ALLOWLIST_URL` and `EGRESS_TICKET_KEY`; for a companion, `EGRESS_HOSTS`.
 */
export function proxySettingsOf(env: NodeJS.ProcessEnv): { port: number; allowlist: TicketSettings | { hosts: string[] } } {
  const port = Number(env.PORT ?? proxyPort);
  const url = env.EGRESS_ALLOWLIST_URL;
  const ticketKey = env.EGRESS_TICKET_KEY;
  if (env.EGRESS_HOSTS !== undefined && !url) {
    return { port, allowlist: { hosts: env.EGRESS_HOSTS.split(";").map((host) => host.trim()).filter((host) => host !== "") } };
  }
  if (!url) throw new Error("EGRESS_ALLOWLIST_URL is not set, nor EGRESS_HOSTS");
  if (!ticketKey) throw new Error("EGRESS_TICKET_KEY is not set");
  return { port, allowlist: { url, ticketKey } };
}
