import { allowedHostsOf } from "./allowlist";
import type { AllowlistFor } from "./proxy";
import { verifyTicket } from "./ticket";
import { pluginServiceOf, proxyPort } from "./wiring";

/** What the proxy of a plugin's own container decides with: the plugin's container, its declared hosts, and the key it checks tickets with. */
export type TicketSettings = { service: string; hosts: string[]; ticketKey: string };

/**
 * The allowlist of a plugin's own proxy, decided from the ticket the plugin call presented alone,
 * without asking anyone: the plugin's declared hosts and the hosts of the ticket's Source. A
 * connection without a ticket, or with one that is expired, not signed with the ticket key or
 * minted for another plugin, is refused.
 */
export function ticketAllowlist({ service, hosts, ticketKey }: TicketSettings, now: () => number = Date.now): AllowlistFor {
  return (presented) => {
    const ticket = presented === null ? null : verifyTicket(ticketKey, presented, now());
    if (ticket === null || pluginServiceOf(ticket.sourceTypeId) !== service) return null;
    return allowedHostsOf(ticket, hosts);
  };
}

/** The allowlist of a companion's proxy: its declared hosts, for any connection; the core never calls a companion. */
export function staticAllowlist(hosts: string[]): AllowlistFor {
  return () => hosts;
}

const hostsOf = (text: string | undefined) => (text ?? "").split(";").map((host) => host.trim()).filter((host) => host !== "");

/**
 * The proxy's port and allowlist from its environment, as compose.plugins.yaml sets them, and what
 * it allows in words for its log: the declared hosts in `EGRESS_HOSTS`; for a plugin's own
 * container also the container it serves in `EGRESS_PLUGIN` and `EGRESS_TICKET_KEY`.
 */
export function proxySettingsOf(env: NodeJS.ProcessEnv, now: () => number = Date.now): { port: number; allowlist: AllowlistFor; allowing: string } {
  const port = Number(env.PORT ?? proxyPort);
  const service = env.EGRESS_PLUGIN;
  const ticketKey = env.EGRESS_TICKET_KEY;
  const hosts = hostsOf(env.EGRESS_HOSTS);
  const declared = hosts.join(", ") || "no declared hosts";
  if (!service) {
    if (env.EGRESS_HOSTS === undefined) throw new Error("EGRESS_PLUGIN is not set, nor EGRESS_HOSTS");
    return { port, allowlist: staticAllowlist(hosts), allowing: declared };
  }
  if (!ticketKey) throw new Error("EGRESS_TICKET_KEY is not set");
  return { port, allowlist: ticketAllowlist({ service, hosts, ticketKey }, now), allowing: `${declared} and the hosts of each ticket for ${service}` };
}
