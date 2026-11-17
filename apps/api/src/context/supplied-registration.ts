import { randomUUID } from "node:crypto";
import { connectPostgres, PostgresFamilyCreatedDeliveryRepository, PostgresProcessedEventRepository, runMigrations, type PostgresConnection } from "@family-agenda/adapters";
import {
  createFamilyCreatedWebhook,
  createRegistrationEvents,
  createSuppliedRegistration,
  type FamilyCreatedWebhook,
  type Registration,
  type RegistrationEvents,
  type WebhookPost,
} from "@family-agenda/application";
import type { SharedWiring } from "../composition-root";
import type { FamilyWebhookConfig } from "../config";

export type SuppliedRegistrationOptions = {
  shared: SharedWiring;
  webhook: Omit<FamilyWebhookConfig, "registrationDatabaseUrl">;
  /** The registration database (`REGISTRATION_DATABASE_URL`), migrated here as a Family's is. */
  database: PostgresConnection;
  post?: WebhookPost;
};

/** A supplied core's registration: what creates a Family, the events that trigger it, and the webhook that tells the platform. */
export type SuppliedRegistration = {
  registration: Registration;
  events: RegistrationEvents;
  webhook: FamilyCreatedWebhook;
  close(): Promise<void>;
};

/** How often pending `family.created` deliveries are looked at; each waits its own backoff. */
export const deliverEveryMs = 10_000;

export type StartedRegistration = {
  /** The events the caller port receives; null while registration is off. */
  events: RegistrationEvents | null;
  close(): Promise<void>;
};

/**
 * Starts a supplied core's registration from `FAMILY_WEBHOOK_*` (ADR-0010), retrying pending
 * deliveries every `deliverEveryMs`, whichever core of the deployment comes first. Off without the
 * webhook: no events are received.
 */
export async function startSuppliedRegistration(
  shared: SharedWiring,
  settings: FamilyWebhookConfig | null,
  log: { error(line: string): void },
  connect: (databaseUrl: string) => PostgresConnection = connectPostgres,
): Promise<StartedRegistration> {
  const opened = settings && (await openSuppliedRegistration({ shared, webhook: settings, database: connect(settings.registrationDatabaseUrl) }));
  if (!opened) return { events: null, close: () => Promise.resolve() };
  const delivering = setInterval(() => {
    opened.webhook.deliverDue().catch((error: unknown) => {
      log.error(`Could not deliver the pending family.created webhooks${error instanceof Error ? ` (${error.name})` : ""}`);
    });
  }, deliverEveryMs);
  delivering.unref();
  return {
    events: opened.events,
    close: () => {
      clearInterval(delivering);
      return opened.close();
    },
  };
}

/**
 * Opens the registration of a core in supplied mode (ADR-0010). A registration belongs to no Family
 * until the platform supplies its Context, so neither its event nor its pending `family.created`
 * delivery can go into a Family's database: both go into the registration database, which every
 * core of the deployment shares. Null without a management API or webhook secret.
 */
export async function openSuppliedRegistration(options: SuppliedRegistrationOptions): Promise<SuppliedRegistration | null> {
  const { shared, webhook: settings, database } = options;
  if (shared.directory === null || shared.idpWebhookSecret === null) return null;
  await runMigrations(database);
  const webhook = createFamilyCreatedWebhook({
    ...settings,
    deliveries: new PostgresFamilyCreatedDeliveryRepository(database.db),
    clock: shared.clock,
    ...(options.post ? { post: options.post } : {}),
  });
  const registration = createSuppliedRegistration({ directory: shared.directory, webhook, newFamilyId: randomUUID });
  const events = createRegistrationEvents({
    clock: shared.clock,
    secret: shared.idpWebhookSecret,
    processedEvents: new PostgresProcessedEventRepository(database.db),
    registration,
  });
  return { registration, events, webhook, close: () => database.close() };
}
