import type { InstalledSourceType, LoadedSourceType, SourceTypeRegistry } from "@family-agenda/application";
import type { SourceTypeId } from "@family-agenda/domain";

/**
 * The Source Types of several registries, such as plugin containers beside plugins in-process while
 * both kinds exist (expand–contract). The first registry naming a Source Type id wins.
 */
export class CombinedRegistry implements SourceTypeRegistry {
  constructor(private readonly registries: SourceTypeRegistry[]) {}

  installed(): InstalledSourceType[] {
    const seen = new Set<string>();
    return this.registries.flatMap((registry) =>
      registry.installed().filter((type) => {
        if (seen.has(type.id)) return false;
        seen.add(type.id);
        return true;
      }),
    );
  }

  async load(id: SourceTypeId): Promise<{ ok: true; sourceType: LoadedSourceType } | { ok: false }> {
    const registry = this.registries.find((candidate) => candidate.installed().some((type) => type.id === id));
    return registry ? registry.load(id) : { ok: false };
  }
}
