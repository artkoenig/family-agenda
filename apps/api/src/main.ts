import { serve } from "@hono/node-server";
import { openAgendaAccess } from "@family-agenda/application";
import { bootApplication } from "./composition-root";
import { readConfig } from "./config";
import { createHttpApp } from "./http/app";
import { createTriggerApp } from "./triggered-operations";

const config = readConfig();
const application = await bootApplication(config);
const server = serve(
  { fetch: createHttpApp(application, {
      trustProxy: config.trustProxy,
      version: config.version,
      ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
      // The only listener in v1 is the local one, where Agendas open without a secret, until Agenda Links are reworked (ADR-0004).
      agendaAccess: openAgendaAccess,
    }).fetch, port: config.port },
  (info) => {
    console.log(`Family Agenda listening on port ${info.port}`);
  },
);

// Triggered operations: the worker's work, for a scheduler of the operator's own. Not published.
const triggers = serve(
  { fetch: createTriggerApp(application, { token: config.triggerToken }).fetch, port: config.triggerPort },
  (info) => {
    console.log(`Triggered operations listening on port ${info.port}`);
  },
);

const shutdown = () => {
  triggers.close();
  server.close(() => {
    void application.close().then(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
