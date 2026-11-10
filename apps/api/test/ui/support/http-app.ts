import { openAgendaAccess } from "@family-agenda/application";
import type { Application } from "../../../src/composition-root";
import { createHttpApp } from "../../../src/http/app";

/** The real HTTP app over `application`. Loaded through tsx by `serve`, never by Playwright itself. */
export function httpAppFor(application: Application) {
  return createHttpApp(application, { trustProxy: false, agendaAccess: openAgendaAccess });
}
