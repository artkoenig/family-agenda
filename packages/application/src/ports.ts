import type {
  Admin,
  BlobRef,
  AdminId,
  Email,
  FamilyId,
  FamilyMember,
  FamilyMemberId,
} from "@family-butler/domain";

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
  recoveryKitConfirmed(id: FamilyId): Promise<boolean>;
  /** Keeps the first confirmation if there is one. */
  confirmRecoveryKit(id: FamilyId, at: Date): Promise<void>;
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

export interface FamilyMemberRepository {
  add(member: FamilyMember): Promise<void>;
  /** In the order they were added. */
  list(familyId: FamilyId): Promise<FamilyMember[]>;
  findById(id: FamilyMemberId): Promise<FamilyMember | null>;
  /** Stores a changed Family Member that was found before. */
  update(member: FamilyMember): Promise<void>;
  remove(id: FamilyMemberId): Promise<void>;
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

/** Where a secret is kept in the SecretStore; stored in Postgres in the secret's place. */
export type SecretRef = string & { readonly __brand: "SecretRef" };

/** Keeps secrets, such as Source credentials, encrypted at rest (ADR-0006). */
export interface SecretStore {
  put(plaintext: string): Promise<SecretRef>;
  /** The plaintext, or null if no secret has this reference. */
  get(ref: SecretRef): Promise<string | null>;
  remove(ref: SecretRef): Promise<void>;
}

/** Keeps files, such as photos and attachments, outside Postgres (ADR-0006). */
export interface BlobStore {
  put(contents: Uint8Array): Promise<BlobRef>;
  /** The contents, or null if no file has this reference. */
  get(ref: BlobRef): Promise<Uint8Array | null>;
  remove(ref: BlobRef): Promise<void>;
}

export interface JobQueue {
  send(name: string, data: object): Promise<void>;
  work(name: string, handler: (data: unknown) => Promise<void>): Promise<void>;
}
