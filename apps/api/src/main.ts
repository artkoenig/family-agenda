import { serve } from "@hono/node-server";
import { openAgendaAccess } from "@family-agenda/application";
import { bootApplication } from "./composition-root";
import { readConfig } from "./config";
import { createAllowlistApp } from "./egress/allowlist-server";
import { allowlistPort } from "./egress/wiring";
import { createHttpApp } from "./http/app";

const config = readConfig();
const application = await bootApplication(config);
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

// Where each plugin container's egress proxy fetches what it allows (ADR-0001).
const allowlistServer = serve({
  fetch: createAllowlistApp({
    declared: config.pluginEgress,
    bindings: config.pluginContainers,
    hostsOf: (sourceTypeId) => application.egressHosts.ofSourceType(sourceTypeId),
  }, config.egressTokens).fetch,
  port: allowlistPort,
});

const shutdown = () => {
  allowlistServer.close();
  server.close(() => {
    void application.close().then(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
