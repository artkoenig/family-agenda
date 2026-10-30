import { serve } from "@hono/node-server";
import { openViewAccess } from "@family-agenda/application";
import { bootApplication } from "./composition-root";
import { readConfig } from "./config";
import { createHttpApp } from "./http/app";

const config = readConfig();
const application = await bootApplication(config);
const server = serve(
  { fetch: createHttpApp(application, {
      trustProxy: config.trustProxy,
      // The only listener in v1 is the local one, where Views open without a secret (ADR-0005).
      viewAccess: openViewAccess,
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
