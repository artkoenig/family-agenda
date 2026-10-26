import { serve } from "@hono/node-server";
import { bootApplication } from "./composition-root";
import { readConfig } from "./config";
import { createHttpApp } from "./http/app";

const config = readConfig();
const application = await bootApplication({ databaseUrl: config.databaseUrl });
const server = serve(
  { fetch: createHttpApp(application, { trustProxy: config.trustProxy }).fetch, port: config.port },
  (info) => {
    console.log(`Family Butler listening on port ${info.port}`);
  },
);

const shutdown = () => {
  server.close(() => {
    void application.close().then(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
