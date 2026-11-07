import { serve } from "@hono/node-server";
import { openAgendaAccess } from "@family-agenda/application";
import { bootSelfHosted } from "@family-agenda/composition";
import { readConfig } from "./config";
import { createHttpApp } from "./http/app";

const config = readConfig();
const application = await bootSelfHosted();
const server = serve(
  { fetch: createHttpApp(application, {
      trustProxy: config.trustProxy,
      version: config.version,
      ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
      // The only listener in v1 is the local one, where Agendas open without a secret (ADR-0005).
      agendaAccess: openAgendaAccess,
    }).fetch, port: config.port },
  (info) => {
    console.log(`Family Agenda listening on port ${info.port}`);
  },
);

const shutdown = () => {
  server.close(() => {
    void application.close().then(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
