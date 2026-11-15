import type { HttpBindings } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { openAgendaAccess } from "@family-agenda/application";
import { bootShared } from "../composition-root";
import type { SuppliedConfig } from "../config";
import { createHttpApp } from "../http/app";
import { SuppliedFamilies } from "./supplied-families";
import { suppliedFetch, type FamilyFetch } from "./supplied-http";

/** How often Families no request used for a while are closed. */
const sweepEveryMs = 60_000;

/**
 * Starts a core in supplied mode (ADR-0003): no database, master key file or blob directory of its
 * own, and no listener on `PORT`: only the caller port, where every request supplies the Context of
 * its Family. The Triggered operations are not offered.
 */
export async function serveSupplied(config: SuppliedConfig, log: { info(message: string): void; warn(message: string): void }) {
  const shared = await bootShared(config);
  const families = new SuppliedFamilies({
    shared,
    // Settings of their own come with the Context later (#380); until then, the environment's for every Family.
    settings: { identityProvider: config.identityProvider },
    serving: (application) => {
      const app = createHttpApp(application, {
        trustProxy: config.trustProxy,
        version: config.version,
        ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
        // As on the one listener of a fixed core: Agendas open without a secret until Agenda Links are reworked (ADR-0004).
        agendaAccess: openAgendaAccess,
      });
      const fetch: FamilyFetch = (request, env) => app.fetch(request, env as HttpBindings);
      return fetch;
    },
  });
  const sweeping = setInterval(() => void families.sweep(), sweepEveryMs);
  sweeping.unref();
  const fetch = suppliedFetch({ contextKey: config.contextKey, families, version: config.version, log });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const listening = serve({ fetch, port: config.callerPort }, (info) => {
      log.info(`Family Agenda listening on caller port ${info.port} in supplied mode`);
      resolve({ server: listening, port: info.port });
    });
  });
  log.info("Triggered operations are off in supplied mode");
  return {
    /** The caller port it listens on. */
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeping);
        server.close(() => void families.close().then(resolve));
      }),
  };
}
