import type { Admin, AdminId, Email, FamilyId } from "@family-butler/domain";

export interface Clock {
  now(): Date;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface FamilyRepository {
  /** The Instance's one Family, created on first use. */
  theFamily(): Promise<FamilyId>;
}

export interface AdminRepository {
  exists(): Promise<boolean>;
  /** Adds the Admin only if no Admin exists yet. Returns whether it was added. */
  addFirst(admin: Admin): Promise<boolean>;
  /** Returns false if the email is taken. */
  add(admin: Admin): Promise<boolean>;
  findById(id: AdminId): Promise<Admin | null>;
  findByEmail(email: Email): Promise<Admin | null>;
  list(familyId: FamilyId): Promise<Admin[]>;
  setPasswordHash(id: AdminId, passwordHash: string): Promise<void>;
}

export type AdminSession = {
  /** A hash of the session token; the token itself is never stored. */
  id: string;
  adminId: AdminId;
  expiresAt: Date;
};

export interface AdminSessionRepository {
  add(session: AdminSession): Promise<void>;
  find(id: string): Promise<AdminSession | null>;
  remove(id: string): Promise<void>;
  removeAllOf(adminId: AdminId): Promise<void>;
}

/** Sign-in attempts that have not succeeded, counted per key (an account or a client). */
export interface SignInFailureLog {
  /** Returns ids of the recorded entries, for `forget`. */
  record(keys: string[], at: Date): Promise<string[]>;
  forget(ids: string[]): Promise<void>;
  countAfter(key: string, after: Date): Promise<number>;
  clear(key: string): Promise<void>;
}

export interface JobQueue {
  send(name: string, data: object): Promise<void>;
  work(name: string, handler: (data: unknown) => Promise<void>): Promise<void>;
}
