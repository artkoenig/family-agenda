import { attributionOf, type Attribution } from "@family-agenda/domain";
import type { ProjectedItem, Source } from "./ports";

/**
 * Whom an Item concerns, by the Family Members assigned to each Origin's Part of its Source, or
 * to the Source itself where the Part is assigned to no one or the Origin has none.
 */
export function concernsOf(item: Pick<ProjectedItem, "sources">, all: readonly Pick<Source, "id" | "concerns" | "partConcerns">[]): Attribution {
  const byId = new Map(all.map((source) => [source.id as string, source]));
  return attributionOf(
    item.sources.map(({ sourceId, part }) => {
      const source = byId.get(sourceId);
      if (!source) return [];
      return (part !== null ? source.partConcerns[part] : undefined) ?? source.concerns;
    }),
  );
}
