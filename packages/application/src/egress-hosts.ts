import type { ConfigFieldSpec, Source } from "./ports";

/**
 * The hosts the Admin entered in host fields of a Source, secret ones too, by their values in the
 * clear: what its plugin's Egress Proxy allows besides the declared hosts while the plugin is
 * called for that Source (ADR-0001).
 */
export function hostsOfSource(fields: ConfigFieldSpec[], source: Pick<Source, "plain" | "secretHosts">): string[] {
  const hosts = new Set<string>();
  for (const { key, secret } of fields.filter((field) => field.host)) {
    const value = secret ? source.secretHosts[key] : source.plain[key];
    if (typeof value === "string" && value.trim() !== "") hosts.add(value.trim());
  }
  return [...hosts];
}
