import type { HttpBindings } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { openAgendaAccess } from "@family-agenda/application";
import { bootShared, invitationAcceptanceOf } from "../composition-root";
import type { SuppliedConfig } from "../config";
import { createHttpApp } from "../http/app";
import { serveSuppliedTriggers, type TriggerLog } from "../triggered-operations";
import { OidcIdentityProviderClient } from "@family-agenda/adapters";
import { startSuppliedRegistration } from "./supplied-registration";
import { SignInRelay } from "./sign-in-relay";
import { SuppliedFamilies } from "./supplied-families";
import { suppliedFetch, type FamilyFetch } from "./supplied-http";

/** How often Families no request used for a while are closed. */
const sweepEveryMs = 60_000;

/**
 * Starts a core in supplied mode (ADR-0003): no database, master key file or blob directory of its
 * own, and no listener on `PORT`: only the caller port, where every request supplies the Context of
 * its Family. With `TRIGGER_TOKEN`, the Triggered operations listen on `TRIGGER_PORT`, each trigger
 * with the Context of its Family too; the core runs no schedule and prepares no Family of its own.
 */
export async function serveSupplied(config: SuppliedConfig, log: TriggerLog) {
  const shared = await bootShared(config);
  const registering = await startSuppliedRegistration(shared, config.familyWebhook, log);
  const client = new OidcIdentityProviderClient();
  const relay = new SignInRelay({ contextKey: config.contextKey, identityProvider: config.identityProvider, client, ...invitationAcceptanceOf(shared, registering.registration) });
  const families = new SuppliedFamilies({
    shared,
    settings: { identityProviderClient: client },
    identityProvider: config.identityProvider,
    serving: (application, context) => {
      const app = createHttpApp(application, {
        signInRelay: relay.forFamily(context),
        trustProxy: config.trustProxy,
        version: config.version,
        legalLinks: config.legalLinks,
        // The Family's own address, its path prefix included: the caller removed the prefix from the request.
        publicUrl: context.publicUrl,
        // As on the one listener of a fixed core: Agendas open without a secret until Agenda Links are reworked (ADR-0004).
        agendaAccess: openAgendaAccess,
      });
      const fetch: FamilyFetch = (request, env, sections) => app.fetch(request, { ...(env as HttpBindings), sections });
      return fetch;
    },
  });
  const sweeping = setInterval(() => void families.sweep(), sweepEveryMs);
  sweeping.unref();
  const signInCallback = { path: relay.callbackPath, answer: (request: Request) => relay.callback(request) };
  const fetch = suppliedFetch({ contextKey: config.contextKey, families, version: config.version, log, signInCallback, registrationEvents: registering.events });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const listening = serve({ fetch, port: config.callerPort }, (info) => {
      log.info(`Family Agenda listening on caller port ${info.port} in supplied mode`);
      resolve({ server: listening, port: info.port });
    });
  });
  // The same opened Families as the pages: a trigger and a request of one Context share one.
  const triggers = serveSuppliedTriggers({ contextKey: config.contextKey, families }, config.trigger, log);
  return {
    /** The caller port it listens on. */
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeping);
        triggers?.close();
        server.close(() => void families.close().then(() => registering.close()).then(resolve));
      }),
  };
}
