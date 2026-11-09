import type { SourceTypeId } from "@family-agenda/domain";
import type { SourceRepository, SourceTypeRegistry } from "./ports";

export type EgressHostsDeps = { registry: SourceTypeRegistry; sources: SourceRepository };

/**
 * The hosts the Admin entered in host fields of a Source Type's Sources, secret ones too, which its plugin's egress
 * proxy allows besides the declared ones (ADR-0001). None for a Source Type that cannot be loaded.
 */
export function createEgressHosts({ registry, sources }: EgressHostsDeps) {
  return {
    async ofSourceType(id: SourceTypeId): Promise<string[]> {
      const loaded = await registry.load(id);
      if (!loaded.ok) return [];
      const fields = loaded.sourceType.configuration.fields.filter((field) => field.host);
      const hosts = new Set<string>();
      for (const source of await sources.listOfType(id)) {
        for (const { key, secret } of fields) {
          const value = secret ? source.secretHosts[key] : source.plain[key];
          if (typeof value === "string" && value.trim() !== "") hosts.add(value.trim());
        }
      }
      return [...hosts];
    },
  };
}

export type EgressHosts = ReturnType<typeof createEgressHosts>;
