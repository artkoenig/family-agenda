import { createHash, randomBytes } from "node:crypto";
import type { AdminSessionRepository, Clock } from "./ports";

/** No refresh token: after 12 hours the browser goes through the Identity Provider again (ADR-0009). */
export const sessionLifetimeMs = 12 * 60 * 60 * 1000;

export type AdminAccessDeps = {
  clock: Clock;
  sessions: AdminSessionRepository;
};

/** Whom a session belongs to: whoever the Identity Provider vouched for, as no Admin is stored. */
export type SignedInIdentity = { subject: string; email: string };

/** Whom a session is started for, with the ID token of the sign-in if it gave one. */
export type SessionIdentity = SignedInIdentity & { idToken?: string | undefined };

export function createAdminAccess(deps: AdminAccessDeps) {
  const { clock, sessions } = deps;

  return {
    /** Starts a session for someone the Identity Provider vouched for as an Admin; returns its token. */
    async startSession({ subject, email, idToken }: SessionIdentity): Promise<string> {
      const token = randomBytes(32).toString("base64url");
      const now = clock.now();
      // Sessions no one used again until they expired go here, rather than never.
      await sessions.removeExpired(now);
      const expiresAt = new Date(now.getTime() + sessionLifetimeMs);
      await sessions.add({ id: hashToken(token), subject, email, idToken: idToken ?? null, expiresAt });
      return token;
    },

    /**
     * Ends the session; returns how it was signed in, for signing out at the Identity Provider too:
     * its ID token, null if it has none; or null if there was no such session.
     */
    async signOut(sessionToken: string): Promise<{ idToken: string | null } | null> {
      const session = await sessions.find(hashToken(sessionToken));
      await sessions.remove(hashToken(sessionToken));
      return session ? { idToken: session.idToken } : null;
    },

    /** Who a session token belongs to, or null if it is unknown or expired. */
    async authenticate(sessionToken: string): Promise<SignedInIdentity | null> {
      const session = await sessions.find(hashToken(sessionToken));
      if (!session) return null;
      if (session.expiresAt <= clock.now()) {
        await sessions.remove(session.id);
        return null;
      }
      return { subject: session.subject, email: session.email };
    },
  };
}

export type AdminAccess = ReturnType<typeof createAdminAccess>;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
