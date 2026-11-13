import type { Ticket } from "./ticket";
import { pluginServiceOf } from "./wiring";

/** A host and port to connect to. */
export type HostPort = { host: string; port: number };

/** One allowed destination: a host, or `*.example.org` for the names below it, on one port or any. */
export type AllowEntry = { name: string; wildcard: boolean; port: number | null };

/**
 * The declared egress hosts per plugin container of `PLUGIN_EGRESS`, containers separated by
 * commas, such as `plugin-demo=api.example.com:443;*.example.org:443,plugin-imap=login.example.com:443`.
 */
export function parsePluginEgress(text: string | undefined): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  for (const entry of (text ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    const at = entry.indexOf("=");
    const service = entry.slice(0, Math.max(at, 0)).trim();
    if (service === "") throw new Error(`PLUGIN_EGRESS takes containers with values, such as plugin-demo=...; "${entry}" is none`);
    const hosts = entry.slice(at + 1).split(";").map((host) => host.trim()).filter((host) => host !== "");
    declared.set(service, [...(declared.get(service) ?? []), ...hosts]);
  }
  return declared;
}

/** What the allowlist needs of one Family. */
export type FamilyEgress = {
  /** The host field values of the stored Source `sourceId` of `sourceTypeId`; null for none such. */
  hostsOf(sourceId: string, sourceTypeId: string): Promise<string[] | null>;
};

export type AllowlistSources = {
  /** The declared egress hosts per plugin container, from `PLUGIN_EGRESS`. */
  declared: Map<string, string[]>;
  /** The Family a ticket names, through its own database; null for one the Instance does not serve. */
  family: (familyId: string) => Promise<FamilyEgress | null>;
};

/**
 * What the egress proxy of container `service` allows for the plugin call `ticket` was minted for
 * (ADR-0001): the container's declared hosts and the hosts the Admin entered in host fields of that
 * one Source, read from its Family's database, or carried by the ticket for a Source that is not
 * stored. Null where the ticket does not hold: for a Family the Instance does not serve, a Source it
 * does not have, or a container other than the plugin's own.
 */
export async function allowlistOf(
  service: string,
  ticket: Ticket,
  { declared, family }: AllowlistSources,
): Promise<string[] | null> {
  if (pluginServiceOf(ticket.sourceTypeId) !== service) return null;
  const egress = await family(ticket.familyId);
  if (egress === null) return null;
  const hosts = ticket.hosts ?? (await egress.hostsOf(ticket.sourceId, ticket.sourceTypeId));
  if (hosts === null) return null;
  return [...new Set([...(declared.get(service) ?? []), ...hosts.flatMap(hostFieldEntry)])];
}

/**
 * What an Admin's host field value allows: one host, with its port or on any port, written in
 * lowercase. Like plugins, it drops an `http(s)://` or `webcal://` scheme and everything from the
 * first `/`, `?` or `#`, so a pasted URL allows its host. Nothing for anything else, such as `*`, a
 * wildcard, another scheme or a port out of range.
 */
function hostFieldEntry(value: string): string[] {
  const unschemed = value.trim().replace(/^(?:https?|webcal):\/\//i, "");
  const end = unschemed.search(/[/?#]/);
  const bare = end === -1 ? unschemed : unschemed.slice(0, end);
  const entry = parseEntry(bare);
  if (entry === null || entry.wildcard) return [];
  return [entry.port === null ? entry.name : `${entry.name}:${entry.port}`];
}

/** An allowlist entry `host:port`, `host` for any port, or `*.example.org:443`; null if it is none. */
export function parseEntry(text: string): AllowEntry | null {
  const match = /^(\*\.)?([a-z0-9.-]+?)(?::(\d{1,5}))?$/.exec(text.trim().toLowerCase());
  if (match === null) return null;
  const name = match[2] ?? "";
  if (!isHostName(name)) return null;
  const port = match[3] === undefined ? null : Number(match[3]);
  if (port !== null && !isPort(port)) return null;
  return { name, wildcard: match[1] !== undefined, port };
}

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A DNS name of labels, such as `imap.example.org`. */
export function isHostName(name: string): boolean {
  return name.length <= 253 && name.split(".").every((part) => label.test(part));
}

export const isPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65_535;

/** Whether `entries` let a connection to `target` through. */
export function allows(entries: AllowEntry[], target: HostPort): boolean {
  const host = target.host.toLowerCase();
  return entries.some(({ name, wildcard, port }) => {
    if (port !== null && port !== target.port) return false;
    return wildcard ? host.endsWith(`.${name}`) : host === name;
  });
}
