import type { SourceTypeId } from "@family-agenda/domain";
import type { PluginBinding } from "../plugin-containers/bindings";

/**
 * The declared egress hosts per container of `PLUGIN_EGRESS`, such as
 * `plugin-demo=api.example.com:443;*.example.org:443,plugin-demo-companion=example.net:443`.
 */
export function parsePluginEgress(text: string | undefined): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  for (const entry of (text ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    const at = entry.indexOf("=");
    const service = entry.slice(0, Math.max(at, 0)).trim();
    if (service === "") throw new Error(`PLUGIN_EGRESS takes containers with hosts, such as plugin-demo=api.example.com:443; "${entry}" is none`);
    const hosts = entry.slice(at + 1).split(";").map((host) => host.trim()).filter((host) => host !== "");
    declared.set(service, [...(declared.get(service) ?? []), ...hosts]);
  }
  return declared;
}

export type AllowlistSources = {
  /** From `PLUGIN_EGRESS`. */
  declared: Map<string, string[]>;
  /** From `PLUGIN_URLS`: a container whose host is a binding's is that Source Type's plugin. */
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
  const binding = bindings.find((candidate) => new URL(candidate.url).hostname === service);
  const fromSources = binding === undefined ? [] : await hostsOf(binding.sourceTypeId);
  return [...new Set([...(declared.get(service) ?? []), ...fromSources])];
}

/**
 * Whether `allowlist` lets a connection to `host` on `port` through. An entry is `host:port` or
 * `host`, for any port; a host `*.example.org` stands for every name below example.org.
 */
export function allows(allowlist: string[], host: string, port: number): boolean {
  const target = host.toLowerCase();
  return allowlist.some((entry) => {
    const { name, port: allowedPort } = splitEntry(entry.toLowerCase());
    if (allowedPort !== null && allowedPort !== port) return false;
    return name.startsWith("*.") ? target.endsWith(name.slice(1)) : target === name;
  });
}

function splitEntry(entry: string): { name: string; port: number | null } {
  const match = /^(.*):(\d+)$/.exec(entry);
  return match === null ? { name: entry, port: null } : { name: match[1] ?? "", port: Number(match[2]) };
}
