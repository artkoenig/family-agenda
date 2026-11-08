import { serve } from "@hono/node-server";
import { openAgendaAccess } from "@family-agenda/application";
import { bootSelfHosted, createWorkScheduler, readFamilyDatabase, WorkerClient, workerFrom } from "@family-agenda/composition";
import { readConfig } from "./config";
import { createHttpApp } from "./http/app";

const config = readConfig();
const application = await bootSelfHosted();
// api keeps the Family's schedule and triggers the worker, which holds no Family of its own.
const scheduler = createWorkScheduler({
  worker: new WorkerClient(workerFrom(process.env)),
  family: await readFamilyDatabase(),
  log: {
    warn: (message) => {
      console.warn(message);
    },
    error: (message, error) => {
      console.error(message, error);
    },
  },
});
scheduler.start();
const server = serve(
  { fetch: createHttpApp(application, {
      trustProxy: config.trustProxy,
      version: config.version,
      ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
      // The only listener in v1 is the local one, where Agendas open without a secret.
      agendaAccess: openAgendaAccess,
    }).fetch, port: config.port },
  (info) => {
    console.log(`Family Agenda listening on port ${info.port}`);
  },
);

const shutdown = () => {
  server.close(() => {
    void scheduler
      .stop()
      .then(() => application.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
