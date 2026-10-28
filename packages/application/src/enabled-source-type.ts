import type { SourceTypeId } from "@family-agenda/domain";
import type { LoadedSourceType, SourceTypeRegistry, SourceTypeRepository } from "./ports";

/** The plugin of an enabled Source Type, or null. */
export async function enabledSourceType(
  sourceTypeId: SourceTypeId,
  deps: { registry: SourceTypeRegistry; sourceTypes: SourceTypeRepository },
): Promise<LoadedSourceType | null> {
  const record = (await deps.sourceTypes.list()).find((type) => type.id === sourceTypeId);
  const loaded = record?.enabled ? await deps.registry.load(sourceTypeId) : null;
  return loaded?.ok ? loaded.sourceType : null;
}
