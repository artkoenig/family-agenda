import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  isAcceptablePassword,
  isFamilyLanguage,
  ocrLanguageOf,
  parseEmail,
  type Admin,
  type AdminId,
  type Email,
} from "@family-agenda/domain";
import type {
  AdminRepository,
  AdminSessionRepository,
  Clock,
  FamilyRepository,
  PasswordHasher,
  SignInFailureLog,
} from "./ports";

export const sessionLifetimeMs = 14 * 24 * 60 * 60 * 1000;

/** Failed sign-ins allowed per window before further attempts are refused. */
export const signInLimits = {
  windowMs: 15 * 60 * 1000,
  perAccount: 5,
  perClient: 20,
};

export type AdminAccessDeps = {
  clock: Clock;
  passwordHasher: PasswordHasher;
  families: FamilyRepository;
  admins: AdminRepository;
  sessions: AdminSessionRepository;
  signInFailures: SignInFailureLog;
};

export type AdminSummary = { id: AdminId; email: Email };

export type AccountProblem = "invalid-email" | "password-too-short";

export type CreateFirstAdminResult =
  | { ok: true; sessionToken: string }
  | { ok: false; problem: AccountProblem | "admin-exists" | "invalid-language" };

export type SignInResult =
  | { ok: true; sessionToken: string }
  | { ok: false; problem: "invalid-credentials" | "rate-limited" };

export type PasswordResetResult =
  | { ok: true }
  | { ok: false; problem: "password-too-short" | "own-account" | "unknown-admin" };

export function createAdminAccess(deps: AdminAccessDeps) {
  const { clock, passwordHasher, families, admins, sessions, signInFailures } = deps;
  // Verified against when an email is unknown, so that the answer takes as long as for a known one.
  const unknownAccountHash = passwordHasher.hash(randomBytes(16).toString("hex"));

  async function startSession(adminId: AdminId): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const now = clock.now();
    // Sessions no one used again until they expired go here, rather than never.
    await sessions.removeExpired(now);
    const expiresAt = new Date(now.getTime() + sessionLifetimeMs);
    await sessions.add({ id: hashToken(token), adminId, expiresAt });
    return token;
  }

  async function newAdmin(
    rawEmail: string,
    password: string,
  ): Promise<{ ok: true; admin: Admin } | { ok: false; problem: AccountProblem }> {
    const email = parseEmail(rawEmail);
    if (!email) return { ok: false, problem: "invalid-email" };
    if (!isAcceptablePassword(password)) return { ok: false, problem: "password-too-short" };
    const admin: Admin = {
      id: randomUUID() as AdminId,
      email,
      passwordHash: await passwordHasher.hash(password),
      createdAt: clock.now(),
    };
    return { ok: true, admin };
  }

  async function setPassword(admin: Admin, newPassword: string): Promise<PasswordResetResult> {
    if (!isAcceptablePassword(newPassword)) return { ok: false, problem: "password-too-short" };
    await admins.setPasswordHash(admin.id, await passwordHasher.hash(newPassword));
    await sessions.removeAllOf(admin.id);
    return { ok: true };
  }

  const rateLimited = async (accountKey: string, clientKey: string, windowStart: Date): Promise<boolean> => {
    const [accountFailures, clientFailures] = await Promise.all([
      signInFailures.countAfter(accountKey, windowStart),
      signInFailures.countAfter(clientKey, windowStart),
    ]);
    return accountFailures > signInLimits.perAccount || clientFailures > signInLimits.perClient;
  };

  /** The Admin when the password matches; an unknown account is verified against a dummy hash all the same. */
  const authenticated = async (admin: Admin | null, password: string): Promise<Admin | null> => {
    const passwordMatches = await passwordHasher.verify(
      admin?.passwordHash ?? (await unknownAccountHash),
      password,
    );
    return passwordMatches ? admin : null;
  };

  return {
    async needsFirstAdmin(): Promise<boolean> {
      return !(await admins.exists());
    },

    /** Sets up the Family too: its Family Language, if given, and OCR in that language. */
    async createFirstAdmin(input: {
      email: string;
      password: string;
      language?: string;
    }): Promise<CreateFirstAdminResult> {
      if (await admins.exists()) return { ok: false, problem: "admin-exists" };
      const { language } = input;
      if (language !== undefined && !isFamilyLanguage(language)) return { ok: false, problem: "invalid-language" };
      const result = await newAdmin(input.email, input.password);
      if (!result.ok) return result;
      if (!(await admins.addFirst(result.admin))) return { ok: false, problem: "admin-exists" };
      if (language !== undefined) {
        await families.saveLanguages({ language, ocrLanguages: [ocrLanguageOf(language)] });
      }
      return { ok: true, sessionToken: await startSession(result.admin.id) };
    },

    /** `client` identifies where the attempt comes from, such as an IP address. */
    async signIn(input: { email: string; password: string; client: string }): Promise<SignInResult> {
      const now = clock.now();
      const windowStart = new Date(now.getTime() - signInLimits.windowMs);
      const email = parseEmail(input.email);
      const accountKey = `account:${email ?? input.email}`;
      const clientKey = `client:${input.client}`;

      // Recorded before checking, so that attempts arriving at the same time count each other.
      const attempt = await signInFailures.record([accountKey, clientKey], now);
      if (await rateLimited(accountKey, clientKey, windowStart)) {
        await signInFailures.forget(attempt);
        return { ok: false, problem: "rate-limited" };
      }

      const admin = email ? await admins.findByEmail(email) : null;
      const verified = await authenticated(admin, input.password);
      if (!verified) {
        return { ok: false, problem: "invalid-credentials" };
      }

      await signInFailures.forget(attempt);
      await signInFailures.clear(accountKey);
      return { ok: true, sessionToken: await startSession(verified.id) };
    },

    async signOut(sessionToken: string): Promise<void> {
      await sessions.remove(hashToken(sessionToken));
    },

    async listAdmins(): Promise<AdminSummary[]> {
      const all = await admins.list();
      return all.map((admin) => ({ id: admin.id, email: admin.email }));
    },

    /** Admins are equal: any Admin can create another. */
    async createAdmin(input: {
      email: string;
      password: string;
    }): Promise<{ ok: true } | { ok: false; problem: AccountProblem | "email-taken" }> {
      const result = await newAdmin(input.email, input.password);
      if (!result.ok) return result;
      if (!(await admins.add(result.admin))) return { ok: false, problem: "email-taken" };
      return { ok: true };
    },

    /** Resets another Admin's password, for one who forgot theirs, and ends their sessions. */
    async resetPassword(
      actor: AdminSummary,
      input: { adminId: AdminId; newPassword: string },
    ): Promise<PasswordResetResult> {
      if (input.adminId === actor.id) return { ok: false, problem: "own-account" };
      const admin = await admins.findById(input.adminId);
      if (!admin) return { ok: false, problem: "unknown-admin" };
      return setPassword(admin, input.newPassword);
    },

    /** For the CLI inside the container, which needs no signed-in Admin. */
    async resetPasswordByEmail(input: {
      email: string;
      newPassword: string;
    }): Promise<PasswordResetResult> {
      const email = parseEmail(input.email);
      const admin = email && (await admins.findByEmail(email));
      if (!admin) return { ok: false, problem: "unknown-admin" };
      return setPassword(admin, input.newPassword);
    },

    /** The Admin a session token belongs to, or null if it is unknown or expired. */
    async authenticate(sessionToken: string): Promise<AdminSummary | null> {
      const session = await sessions.find(hashToken(sessionToken));
      if (!session) return null;
      if (session.expiresAt <= clock.now()) {
        await sessions.remove(session.id);
        return null;
      }
      const admin = await admins.findById(session.adminId);
      return admin && { id: admin.id, email: admin.email };
    },
  };
}

export type AdminAccess = ReturnType<typeof createAdminAccess>;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
