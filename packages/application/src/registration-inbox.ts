import type { IdentityDirectory } from "./identity-directory";
import type { Clock } from "./ports";
import type { Registration, RegistrationEvent } from "./registration-events";

/** A registration kept in the inbox (ADR-0010): the user, the Family id its organization holds, and the organization once created. */
export type StoredRegistration = RegistrationEvent & {
  /** The drawn Family id in supplied mode; null in fixed mode, where it is the Family's. */
  familyId: string | null;
  /** The organization created for it, noted as soon as it is; null before. */
  organizationId: string | null;
  /** The failed tries so far, which lengthen the wait before the next. */
  attempts: number;
};

/** What the user's registration is when an invitation is to be accepted: taken here, none left to do, or being carried elsewhere. */
export type RegistrationTaken = { taken: StoredRegistration } | "settled" | "busy";

/**
 * The registrations received and not yet carried through (ADR-0010): each is kept by its user, so a
 * redelivered event finds it there, and taken under a lease, so a core that dies lets another go on.
 */
export interface RegistrationInboxRepository {
  /** Keeps the registration, due now, unless the user's is kept already; whether it was new. */
  add(registration: { userId: string; email: string; familyId: string | null }, at: Date): Promise<boolean>;
  /**
   * Takes up to `limit` registrations not done and due at `now` that no one holds, holding each
   * until `leaseUntil`. `alone`: at most one, and none while another is held.
   */
  takeDue(now: Date, leaseUntil: Date, limit: number, alone: boolean): Promise<StoredRegistration[]>;
  /** Takes the user's registration if it is not done and no one holds it, whether due or not; `alone` as for `takeDue`. */
  takeOf(userId: string, now: Date, leaseUntil: Date, alone: boolean): Promise<RegistrationTaken>;
  /** Notes the organization created for the registration, before anything else happens to it. */
  noteOrganization(userId: string, organizationId: string): Promise<void>;
  /** Marks the registration done and lets it go. */
  done(userId: string, at: Date): Promise<void>;
  /** Lets a failed registration go, due again at `at` after `attempts` tries. */
  retryAt(userId: string, attempts: number, at: Date): Promise<void>;
}

/** What differs between the two modes of registration: whose Family id, what is checked first and what ends it. */
export interface RegistrationMode {
  /** Whether a registration would create a Family now. */
  isOpen(): Promise<boolean>;
  /** Fixed mode: at most one registration at a time, as the Family is one. */
  alone: boolean;
  familyIdOf(registration: StoredRegistration): Promise<string>;
  /** Whether the registration creates nothing, looked at before an organization is created or reused. */
  createsNothing(registration: StoredRegistration): Promise<boolean>;
  /** Ends a registration that created nothing. */
  nothing(registration: StoredRegistration): Promise<void>;
  /** Ends a registration whose user is now an Admin of the organization. */
  finish(registration: StoredRegistration, organizationId: string, familyId: string): Promise<void>;
}

/** How long a core may take for one registration before another core takes it on. */
const leaseMs = 5 * 60_000;
/** How many registrations one round takes. */
const batchSize = 20;
/** The first retry's wait, which doubles with each try up to `maxRetryDelayMs`. */
const firstRetryDelayMs = 10_000;
const maxRetryDelayMs = 60 * 60_000;

/** The wait before the next try after `attempts` failed ones: 10 s, 20 s, 40 s, … at most an hour. */
export const registrationRetryDelayMs = (attempts: number): number => Math.min(firstRetryDelayMs * 2 ** (attempts - 1), maxRetryDelayMs);

export type RegistrationInboxDeps = {
  clock: Clock;
  registrations: RegistrationInboxRepository;
  directory: IdentityDirectory;
  mode: RegistrationMode;
  /** A new, random Family id, drawn when a registration is received in supplied mode. */
  newFamilyId?: () => string;
};

/**
 * Registration through an inbox (ADR-0010): an event is kept as a registration and answered at
 * once; the registration is then carried through step by step, each step noted or repeatable, so
 * that a redelivery, a failure or a core dying midway ends in one Family with its Admin.
 */
export function createRegistrationInbox(deps: RegistrationInboxDeps): Registration {
  const { clock, registrations, directory, mode, newFamilyId } = deps;
  const leaseUntil = () => new Date(clock.now().getTime() + leaseMs);

  /** The organization the registration noted, or one an earlier try created and could not note. */
  async function organizationOf(registration: StoredRegistration, familyId: string): Promise<string | null> {
    return registration.organizationId ?? (await directory.findOrganization(familyId));
  }

  async function createsNothing(registration: StoredRegistration): Promise<boolean> {
    const organizations = await directory.organizationsOf(registration.userId);
    // A deleted user, or one already an Admin of another Family, such as through an invitation.
    if (organizations === null || organizations.some((id) => id !== registration.organizationId)) return true;
    return mode.createsNothing(registration);
  }

  async function nothing(registration: StoredRegistration, familyId: string): Promise<void> {
    // An organization an earlier try created goes again, unless someone is in it: none is left empty.
    const organizationId = mode.alone ? null : await organizationOf(registration, familyId);
    if (organizationId !== null && (await directory.listMembers(organizationId)).length === 0) await directory.deleteOrganization(organizationId);
    await mode.nothing(registration);
  }

  async function carry(registration: StoredRegistration): Promise<void> {
    const familyId = await mode.familyIdOf(registration);
    if (await createsNothing(registration)) {
      await nothing(registration, familyId);
    } else {
      let organizationId = await organizationOf(registration, familyId);
      organizationId ??= await directory.createOrganization(familyId, organizationName(familyId));
      if (registration.organizationId === null) await registrations.noteOrganization(registration.userId, organizationId);
      await directory.addMember(organizationId, registration.userId);
      await mode.finish(registration, organizationId, familyId);
    }
    await registrations.done(registration.userId, clock.now());
  }

  /** Carries the registration through, or lets it go to be retried; whether it is done. */
  async function attempt(registration: StoredRegistration): Promise<boolean> {
    try {
      await carry(registration);
      return true;
    } catch {
      const attempts = registration.attempts + 1;
      await registrations.retryAt(registration.userId, attempts, new Date(clock.now().getTime() + registrationRetryDelayMs(attempts)));
      return false;
    }
  }

  async function retry(): Promise<number> {
    const due = await registrations.takeDue(clock.now(), leaseUntil(), batchSize, mode.alone);
    const results = await Promise.all(due.map(attempt));
    return results.filter(Boolean).length;
  }

  return {
    isOpen: () => mode.isOpen(),
    async register(event) {
      const familyId = newFamilyId ? newFamilyId() : null;
      if (await registrations.add({ ...event, familyId }, clock.now())) await retry();
    },
    retry,
    async settle(userId) {
      const taken = await registrations.takeOf(userId, clock.now(), leaseUntil(), mode.alone);
      if (taken === "settled") return true;
      if (taken === "busy") return false;
      return attempt(taken.taken);
    },
  };
}

/** The name the Family's organization gets in the Identity Provider, which carries its Family id so that it can be found by it. */
export const organizationName = (familyId: string): string => `Family Agenda ${familyId}`;
