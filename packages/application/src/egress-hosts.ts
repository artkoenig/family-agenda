import type { SourceId, SourceTypeId } from "@family-agenda/domain";
import type { ConfigFieldSpec, Source, SourceRepository, SourceTypeRegistry } from "./ports";

export type EgressHostsDeps = { registry: SourceTypeRegistry; sources: SourceRepository };

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

export function createEgressHosts({ registry, sources }: EgressHostsDeps) {
  return {
    /**
     * The hosts of a stored Source of Source Type `sourceTypeId`; null for none stored, or one of
     * another type. None for a Source whose Source Type cannot be loaded.
     */
    async ofSource(id: SourceId, sourceTypeId: SourceTypeId): Promise<string[] | null> {
      const source = await sources.findById(id);
      if (source?.sourceTypeId !== sourceTypeId) return null;
      const loaded = await registry.load(sourceTypeId);
      return loaded.ok ? hostsOfSource(loaded.sourceType.configuration.fields, source) : [];
    },
  };
}

export type EgressHosts = ReturnType<typeof createEgressHosts>;
