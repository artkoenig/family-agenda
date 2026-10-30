import type { ViewPage } from "@family-agenda/application";
import type { Application } from "../../src/composition-root";

/** Opens a View that must be a timeline, as most tests read its days. */
export async function openTimeline(app: Application, ...input: Parameters<Application["views"]["open"]>): Promise<ViewPage | null> {
  const page = await app.views.open(...input);
  if (page && page.kind !== "timeline") throw new Error(`View ${input[0]} is a ${page.kind} View, not a timeline`);
  return page;
}
