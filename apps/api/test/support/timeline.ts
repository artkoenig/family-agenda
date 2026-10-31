import type { AgendaPage } from "@family-agenda/application";
import type { Application } from "../../src/composition-root";

/** Opens an Agenda that must be a timeline, as most tests read its days. */
export async function openTimeline(app: Application, ...input: Parameters<Application["agendas"]["open"]>): Promise<AgendaPage | null> {
  const page = await app.agendas.open(...input);
  if (page && page.kind !== "timeline") throw new Error(`Agenda ${input[0]} is a ${page.kind} Agenda, not a timeline`);
  return page;
}
