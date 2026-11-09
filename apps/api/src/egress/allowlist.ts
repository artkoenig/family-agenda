import type { SourceTypeId } from "@family-agenda/domain";
import type { PluginBinding } from "../plugin-containers/bindings";
import { pluginServiceOf } from "./wiring";

/** A host and port to connect to. */
export type HostPort = { host: string; port: number };

/** One allowed destination: a host, or `*.example.org` for the names below it, on one port or any. */
export type AllowEntry = { name: string; wildcard: boolean; port: number | null };

/**
 * Pairs `<container>=<value>` separated by commas, each container named once, as `PLUGIN_EGRESS`
 * and `PLUGIN_EGRESS_TOKENS` hold them.
 */
function parsePairs(variable: string, text: string | undefined): [string, string][] {
  return (text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((entry) => {
      const at = entry.indexOf("=");
      const service = entry.slice(0, Math.max(at, 0)).trim();
      if (service === "") throw new Error(`${variable} takes containers with values, such as plugin-demo=...; "${entry}" is none`);
      return [service, entry.slice(at + 1).trim()];
    });
}

/**
 * The declared egress hosts per container of `PLUGIN_EGRESS`, such as
 * `plugin-demo=api.example.com:443;*.example.org:443,plugin-demo-companion=example.net:443`.
 */
export function parsePluginEgress(text: string | undefined): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  for (const [service, value] of parsePairs("PLUGIN_EGRESS", text)) {
    const hosts = value.split(";").map((host) => host.trim()).filter((host) => host !== "");
    declared.set(service, [...(declared.get(service) ?? []), ...hosts]);
  }
  return declared;
}

/** The token per egress proxy's container of `PLUGIN_EGRESS_TOKENS`, such as `plugin-demo=abc`. */
export function parseEgressTokens(text: string | undefined): Map<string, string> {
  return new Map(parsePairs("PLUGIN_EGRESS_TOKENS", text).filter(([, token]) => token !== ""));
}

export type AllowlistSources = {
  /** From `PLUGIN_EGRESS`. */
  declared: Map<string, string[]>;
  /** From `PLUGIN_URLS`: the Source Types whose plugins run in containers. */
  bindings: PluginBinding[];
  /** The hosts in host fields of a Source Type's Sources. */
  hostsOf: (sourceTypeId: SourceTypeId) => Promise<string[]>;
};

/**
 * What the egress proxy of container `service` allows (ADR-0001): its declared hosts and, for a
 * plugin's own container, the hosts the Admin entered in host fields of that plugin's Sources.
 * Nothing for a container the core does not know.
 */
export async function allowlistOf(service: string, { declared, bindings, hostsOf }: AllowlistSources): Promise<string[]> {
  const binding = bindings.find((candidate) => pluginServiceOf(candidate.sourceTypeId) === service);
  const fromSources = binding === undefined ? [] : (await hostsOf(binding.sourceTypeId)).flatMap(hostFieldEntry);
  return [...new Set([...(declared.get(service) ?? []), ...fromSources])];
}

/**
 * What an Admin's host field value allows: one host, with its port or on any port, written in
 * lowercase; nothing for anything else, such as `*`, a wildcard, a URL, a path or a port out of range.
 */
function hostFieldEntry(value: string): string[] {
  const entry = parseEntry(value);
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
