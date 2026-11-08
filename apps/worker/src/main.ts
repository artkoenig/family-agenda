import { serve } from "@hono/node-server";
import { bootSelfHostedWorker, createWorkerHandler } from "@family-agenda/composition";

/**
 * The worker holds no schedule and no Family of its own: api triggers each kind of work over HTTP,
 * naming the Family's database, and the worker answers once the work is done.
 */
const token = process.env.WORKER_TOKEN;
if (!token) throw new Error("WORKER_TOKEN is not set. Set it to the same random token for api and worker, such as one from: openssl rand -hex 32");
const port = Number(process.env.WORKER_PORT ?? 4200);

const service = bootSelfHostedWorker();
const server = serve({ fetch: createWorkerHandler(service, token), port }, (info) => {
  console.log(`Family Agenda worker listening on port ${info.port}`);
});

const shutdown = () => {
  server.close(() => {
    void service.close().then(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
