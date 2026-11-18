import { createHmac } from "node:crypto";
import type { IdentityDirectory } from "./identity-directory";
import type { Clock } from "./ports";
import { createRegistrationInbox, type RegistrationInboxRepository, type RegistrationMode } from "./registration-inbox";
import type { Registration } from "./registration-events";

/** What the platform learns of a new Family in supplied mode (ADR-0010): enough to supply its Context. */
export type FamilyCreated = { familyId: string; organizationId: string; email: string };

/** A `family.created` webhook not yet answered `2xx`, with the tries so far. */
export type PendingDelivery = FamilyCreated & { attempts: number };

/** The pending `family.created` deliveries, kept until the platform takes each (ADR-0010). */
export interface FamilyCreatedDeliveryRepository {
  /** Keeps a delivery, due at `dueAt`; one for the same Family is kept as it is. */
  add(created: FamilyCreated, dueAt: Date): Promise<void>;
  /** Takes up to `limit` deliveries due at `now`, putting each one's next try off to `leaseUntil` so that no other core tries at once. */
  takeDue(now: Date, leaseUntil: Date, limit: number): Promise<PendingDelivery[]>;
  /** Forgets a delivery the platform took. */
  delivered(familyId: string): Promise<void>;
  /** Records a failed try and when the next is due. */
  retryAt(familyId: string, attempts: number, at: Date): Promise<void>;
}

/** Posts a webhook; resolves to the status it was answered with, rejects when it got no answer. */
export type WebhookPost = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<number>;

/** The header the platform checks the hex HMAC-SHA256 of the body in, keyed with `FAMILY_WEBHOOK_SECRET`. */
export const familyWebhookSignatureHeader = "family-agenda-signature-sha-256";

/** How long a core may take for one delivery before another core tries it again. */
const leaseMs = 5 * 60_000;
/** How many deliveries one round tries. */
const batchSize = 20;
/** The first retry's wait, which doubles with each try up to `maxRetryDelayMs`. */
const firstRetryDelayMs = 10_000;
const maxRetryDelayMs = 60 * 60_000;

/** The wait before the next try after `attempts` failed ones: 10 s, 20 s, 40 s, … at most an hour. */
export const retryDelayMs = (attempts: number): number => Math.min(firstRetryDelayMs * 2 ** (attempts - 1), maxRetryDelayMs);

export type FamilyCreatedWebhookDeps = {
  /** `FAMILY_WEBHOOK_URL`. */
  url: string;
  /** `FAMILY_WEBHOOK_SECRET`, the key the body is signed with. */
  secret: string;
  deliveries: FamilyCreatedDeliveryRepository;
  clock: Clock;
  post?: WebhookPost;
};

export type FamilyCreatedWebhook = {
  /** Keeps the delivery, then tries what is due; a failed try is retried later, not thrown. */
  send(created: FamilyCreated): Promise<void>;
  /** Tries the deliveries due now; resolves to how many the platform took. */
  deliverDue(): Promise<number>;
};

/** A webhook post with `fetch`, given up after 10 seconds. */
export const fetchPost: WebhookPost = async (url, { headers, body }) =>
  (await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) })).status;

/**
 * The signed `family.created` webhook to the platform (ADR-0010), retried with backoff until it
 * answers `2xx`; the Family id is its idempotency key, as a retry may follow a lost answer.
 */
export function createFamilyCreatedWebhook(deps: FamilyCreatedWebhookDeps): FamilyCreatedWebhook {
  const { url, secret, deliveries, clock, post = fetchPost } = deps;

  async function tryOne(delivery: PendingDelivery): Promise<boolean> {
    const { familyId, organizationId, email } = delivery;
    const body = JSON.stringify({ event: "family.created", familyId, organizationId, email });
    const headers = {
      "content-type": "application/json",
      "idempotency-key": familyId,
      [familyWebhookSignatureHeader]: createHmac("sha256", secret).update(body).digest("hex"),
    };
    const status = await post(url, { headers, body }).catch(() => null);
    if (status !== null && status >= 200 && status < 300) {
      await deliveries.delivered(familyId);
      return true;
    }
    const attempts = delivery.attempts + 1;
    await deliveries.retryAt(familyId, attempts, new Date(clock.now().getTime() + retryDelayMs(attempts)));
    return false;
  }

  async function deliverDue(): Promise<number> {
    const now = clock.now();
    const due = await deliveries.takeDue(now, new Date(now.getTime() + leaseMs), batchSize);
    const taken = await Promise.all(due.map(tryOne));
    return taken.filter(Boolean).length;
  }

  return {
    async send(created) {
      await deliveries.add(created, clock.now());
      await deliverDue();
    },
    deliverDue,
  };
}

export type SuppliedRegistrationDeps = {
  clock: Clock;
  registrations: RegistrationInboxRepository;
  directory: IdentityDirectory;
  webhook: FamilyCreatedWebhook;
  /** A new, random Family id. */
  newFamilyId: () => string;
};

/**
 * Registration in supplied mode (ADR-0010): every registration not through an invitation gets a new
 * Family id, drawn as it is received, an organization, the user as its first Admin, and the
 * platform a `family.created` webhook, which it answers by supplying the Family's Context. Always open.
 */
export function createSuppliedRegistration(deps: SuppliedRegistrationDeps): Registration {
  const { clock, registrations, directory, webhook, newFamilyId } = deps;
  const mode: RegistrationMode = {
    isOpen: () => Promise.resolve(true),
    alone: false,
    recordsFounder: true,
    // Drawn as the registration was received, so that every try creates and finds the same.
    familyIdOf: (registration) => (registration.familyId === null ? Promise.reject(new Error(`Registration of ${registration.userId} has no Family id`)) : Promise.resolve(registration.familyId)),
    // An invitee joins the inviting Family; accepting creates no Family.
    createsNothing: (registration) => directory.wasInvited(registration.email),
    nothing: () => Promise.resolve(),
    finish: (registration, organizationId, familyId) => webhook.send({ familyId, organizationId, email: registration.email }),
  };
  return createRegistrationInbox({ clock, registrations, directory, mode, newFamilyId });
}
