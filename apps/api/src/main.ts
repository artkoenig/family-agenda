import { serve } from "@hono/node-server";
import { openAgendaAccess } from "@family-agenda/application";
import { bootFamily, bootShared } from "./composition-root";
import { readConfig, readMode, readSuppliedConfig } from "./config";
import { serveSupplied } from "./context/serve-supplied";
import { createHttpApp } from "./http/app";
import { serveTriggers } from "./triggered-operations";

if (readMode() === "supplied") {
  const supplied = await serveSupplied(readSuppliedConfig(), console);
  const stop = () => void supplied.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else {
  await serveFixed();
}

/** A core of the one Family the environment names. */
async function serveFixed() {
  const config = readConfig();
  const shared = await bootShared(config);
  const application = await bootFamily(shared, config);
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
  const triggered = {
    dueWork: application.dueWork,
    retention: application.retention,
    secretSweep: application.secretSweep,
    admins: application.admins,
  };
  const triggers = serveTriggers(triggered, config.trigger, { info: console.log, warn: console.warn, error: console.error });

  const shutdown = () => {
    triggers?.close();
    server.close(() => {
      void application.close().then(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
