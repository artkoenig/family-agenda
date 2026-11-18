import { createHmac, timingSafeEqual } from "node:crypto";

/** A user who registered in the Identity Provider with a verified email (ADR-0010). */
export type RegistrationEvent = { userId: string; email: string };

/** What a registration does: create the Family and make the user its first Admin (ADR-0010). */
export interface Registration {
  /** Keeps the registration, unless the user's is kept already, and carries it through as far as it goes now. */
  register(event: RegistrationEvent): Promise<void>;
  /** Carries the registrations due through, such as those a failure or a core dying left; resolves to how many are done. */
  retry(): Promise<number>;
  /**
   * Carries the user's registration through before they accept an invitation, so that they do not
   * end up an Admin of two Families; whether none is left to do (false while another core carries it).
   */
  settle(userId: string): Promise<boolean>;
  /** Whether a registration would create a Family now, for the sign-in page to offer sign-up. */
  isOpen(): Promise<boolean>;
}

/** No registration, without a management API or in supplied mode for now: does nothing, never open. */
export const noRegistration: Registration = { register: async () => {}, retry: () => Promise.resolve(0), settle: () => Promise.resolve(true), isOpen: () => Promise.resolve(false) };

/**
 * What became of an event: `handled` by registration, `ignored` as not a registration with a
 * verified email or seen before, `unsigned` for a wrong signature, `malformed` for no event at all.
 */
export type EventOutcome = "handled" | "ignored" | "unsigned" | "malformed";

/** The HTTP status `POST /idp/events` answers an outcome with: the Identity Provider retries only a failure. */
export const eventOutcomeStatus = { handled: 204, ignored: 204, unsigned: 401, malformed: 400 } as const satisfies Record<EventOutcome, number>;

/** The header Logto signs its events in. */
export const idpSignatureHeader = "logto-signature-sha-256";

/** The path the Identity Provider posts its events to. */
export const idpEventsPath = "/idp/events";

export type RegistrationEventDeps = {
  /** The key the Identity Provider signs its events with (`IDP_WEBHOOK_SECRET`). */
  secret: string;
  registration: Registration;
};

export type RegistrationEvents = {
  /** Receives an event as posted, `body` exactly as sent and `signature` its hex HMAC-SHA256 (Logto: `logto-signature-sha-256`). */
  receive(body: string, signature: string | undefined): Promise<EventOutcome>;
};

/** The registration events the Identity Provider's webhook posts (`POST /idp/events`, Logto's `PostRegister`). */
export function createRegistrationEvents(deps: RegistrationEventDeps): RegistrationEvents {
  const { secret, registration } = deps;
  return {
    async receive(body, signature) {
      if (!isSignedBy(secret, body, signature)) return "unsigned";
      const parsed = parseEvent(body);
      if (parsed === null) return "malformed";
      if (parsed.event === null) return "ignored";
      // Kept by its user, who registers once: a redelivery finds it kept and does nothing more.
      await registration.register(parsed.event);
      return "handled";
    },
  };
}

/** Whether `signature` is the HMAC-SHA256 of `body` with `secret`, compared in constant time. */
function isSignedBy(secret: string, body: string, signature: string | undefined): boolean {
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signature ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The registration in a Logto event, null as its event for any other event or an unverified email; null for no event at all. */
function parseEvent(body: string): { event: RegistrationEvent | null } | null {
  const payload = jsonOf(body);
  if (!isRecord(payload) || typeof payload.event !== "string" || !isRecord(payload.user)) return null;
  const userId = nonEmpty(payload.user.id);
  if (userId === null) return null;
  // Logto sets the primary email only once verified, as registration requires (ADR-0010).
  const email = nonEmpty(payload.user.primaryEmail);
  return { event: payload.event === "PostRegister" && email !== null ? { userId, email } : null };
}

const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
