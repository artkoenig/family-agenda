import type { AgendaPage } from "@family-agenda/application";
import type { Application } from "@family-agenda/composition";

/** Opens an Agenda that must be a timeline, as most tests read its days. */
export async function openTimeline(app: Application, ...input: Parameters<Application["agendas"]["open"]>): Promise<AgendaPage | null> {
  const page = await app.agendas.open(...input);
  if (page && page.layout !== "timeline") throw new Error(`Agenda ${input[0]} is a ${page.layout} Agenda, not a timeline`);
  return page;
}
