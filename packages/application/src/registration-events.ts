import { createHmac, timingSafeEqual } from "node:crypto";
import type { Clock, ProcessedEventRepository } from "./ports";

/** A user who registered in the Identity Provider with a verified email (ADR-0010). */
export type RegistrationEvent = { userId: string; email: string };

/** What a registration does: create the Family and make the user its first Admin (ADR-0010). */
export interface Registration {
  register(event: RegistrationEvent): Promise<void>;
}

/** Registration until the Family is created from it: does nothing. */
export const noRegistration: Registration = { register: async () => {} };

/**
 * What became of an event: `handled` by registration, `ignored` as not a registration with a
 * verified email or seen before, `unsigned` for a wrong signature, `malformed` for no event at all.
 */
export type EventOutcome = "handled" | "ignored" | "unsigned" | "malformed";

export type RegistrationEventDeps = {
  clock: Clock;
  /** The key the Identity Provider signs its events with (`IDP_WEBHOOK_SECRET`). */
  secret: string;
  processedEvents: ProcessedEventRepository;
  registration: Registration;
};

export type RegistrationEvents = {
  /** Receives an event as posted, `body` exactly as sent and `signature` its hex HMAC-SHA256 (Logto: `logto-signature-sha-256`). */
  receive(body: string, signature: string | undefined): Promise<EventOutcome>;
};

/** The registration events the Identity Provider's webhook posts (`POST /idp/events`, Logto's `PostRegister`). */
export function createRegistrationEvents(deps: RegistrationEventDeps): RegistrationEvents {
  const { clock, secret, processedEvents, registration } = deps;
  return {
    async receive(body, signature) {
      if (!isSignedBy(secret, body, signature)) return "unsigned";
      const parsed = parseEvent(body);
      if (parsed === null) return "malformed";
      if (parsed.event === null) return "ignored";
      // A user registers once, so the user id names the event; Logto's payload carries no event id.
      const eventId = `PostRegister:${parsed.event.userId}`;
      if (!(await processedEvents.recordIfNew(eventId, clock.now()))) return "ignored";
      try {
        await registration.register(parsed.event);
      } catch (error) {
        // Not processed after all: the Identity Provider's retry gets another go.
        await processedEvents.forget(eventId);
        throw error;
      }
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
