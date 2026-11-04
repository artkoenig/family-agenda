import { attributionOf, type Attribution } from "@family-agenda/domain";
import type { ProjectedItem } from "./ports";

/**
 * Whom an Item concerns: the Family Members assigned to the Source Attributes its Source Record
 * names, or the whole Family if one of them is assigned to no one. Computed on every read, so that
 * a changed assignment applies to Items that came before it.
 */
export function concernsOf(item: Pick<ProjectedItem, "assignments">): Attribution {
  return attributionOf(item.assignments);
}
