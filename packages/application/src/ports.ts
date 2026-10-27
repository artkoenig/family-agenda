import type {
  Act,
  Admin,
  BlobRef,
  AdminId,
  Email,
  FamilyId,
  FamilyMember,
  FamilyMemberId,
  FoldableRevision,
  FoldedItem,
  ItemId,
  ItemKind,
  SourceId,
  SourceTypeId,
  View,
  ViewId,
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

export interface ViewRepository {
  add(view: View): Promise<void>;
  /**
   * In the order they were created, each with its preselected Family Members in the order
   * those were added; Family Members removed since are no longer preselected.
   */
  list(familyId: FamilyId): Promise<View[]>;
  findById(id: ViewId): Promise<View | null>;
  /** Stores a changed View that was found before. */
  update(view: View): Promise<void>;
  remove(id: ViewId): Promise<void>;
}

/**
 * Decides whether a View opens, depending on the listener that accepted the request
 * (ADR-0005). On the local listener every View opens (ADR-0003).
 */
export interface ViewAccessPolicy {
  mayOpen(view: ViewId): Promise<boolean>;
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
  get(ref: BlobRef): Promise<Uint8Array<ArrayBuffer> | null>;
  remove(ref: BlobRef): Promise<void>;
}

/** A Source Type as its plugin's manifest describes it, read without loading the plugin's code. */
export type InstalledSourceType = {
  id: SourceTypeId;
  displayName: string;
  description: string;
  /** The plugin's version. */
  version: string;
  needsLlm: boolean;
  /** Shown before an Admin can enable it; null if there is none. */
  riskNotice: string | null;
  /** Why the plugin cannot be loaded, such as an incompatible SDK version; null if it can. */
  notLoadable: string | null;
};

/** A plain configuration, as JSON. */
export type PlainConfig = Record<string, unknown>;

/** One field of a Source's configuration, as the Admin area renders it. */
export type ConfigFieldSpec = {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  description: string | null;
};

/** What a plugin is given for one run of a Source. */
export type SourceRunContext = {
  plain: PlainConfig;
  secrets: Record<string, string>;
  state: string | null;
  now: Date;
  timeZone: string;
};

/** A Revision as a plugin states it, before the core has checked its fields. */
export type IngestedRevision = {
  itemKind: ItemKind;
  itemKey: string;
  act: Act;
  fields: Record<string, unknown>;
};

/** An Origin as a plugin emits it; raw messages are recorded as Origins without Revisions. */
export type IngestedOrigin = {
  externalId: string;
  /** The source time of its Revisions. */
  occurredAt: Date;
  attributes: Record<string, string>;
  link: string | null;
  revisions: IngestedRevision[];
};

export type SourceRunResult =
  | { ok: true; origins: IngestedOrigin[]; state: string | null }
  /** A definite error needs an Admin; a temporary one is retried. */
  | { ok: false; kind: "definite" | "temporary"; message: string };

export type PollingIngestion = {
  mode: "polling";
  suggestedIntervalSeconds: number;
  /** Runs the plugin; a plugin that throws or emits invalid Origins fails the run. */
  poll(context: SourceRunContext): Promise<SourceRunResult>;
};

/** What the core needs of a loaded plugin; it never asks which one it is. */
export type LoadedSourceType = {
  configuration: {
    version: number;
    fields: ConfigFieldSpec[];
  };
  /** The plain configuration of `fromVersion` migrated to the current version. */
  migrateConfig: (plain: PlainConfig, fromVersion: number) => PlainConfig;
  ingestion: PollingIngestion | { mode: "push" };
};

/** The Source plugins discovered at startup (ADR-0010). */
export interface SourceTypeRegistry {
  installed(): InstalledSourceType[];
  /** Loads the plugin's code once; a plugin that fails to load is not loadable from then on. */
  load(id: SourceTypeId): Promise<{ ok: true; sourceType: LoadedSourceType } | { ok: false }>;
}

/** What the Instance stores per Source Type id, installed or not. */
export type SourceTypeRecord = {
  id: SourceTypeId;
  enabled: boolean;
  /** The application version the Source Type was first discovered in. */
  firstSeenIn: string;
  /** Whether it was discovered since an Admin last opened the list. */
  isNew: boolean;
};

export interface SourceTypeRepository {
  /** Records the ids not stored yet as new and disabled; keeps the others as they are. */
  recordDiscovered(ids: SourceTypeId[], applicationVersion: string, at: Date): Promise<void>;
  list(): Promise<SourceTypeRecord[]>;
  enable(id: SourceTypeId): Promise<void>;
  /** Disables the Source Type unless it has Sources. Returns whether it did. */
  disableIfUnused(id: SourceTypeId): Promise<boolean>;
  markAllSeen(): Promise<void>;
}

export type Source = {
  id: SourceId;
  familyId: FamilyId;
  sourceTypeId: SourceTypeId;
  plain: PlainConfig;
  /** The configuration version of the plugin the plain configuration was stored with. */
  configVersion: number;
  /** Where each secret field's value is kept in the SecretStore. */
  secrets: Record<string, SecretRef>;
  /** The plugin's opaque state, such as a sync token, handed back on its next run. */
  state: string | null;
  /** How often the worker polls it, as an Admin set it; null for the plugin's suggestion. */
  pollIntervalSeconds: number | null;
  /** When the worker last ran it, successfully or not; null before its first run. */
  lastRunAt: Date | null;
  createdAt: Date;
};

export interface SourceRepository {
  add(source: Source): Promise<void>;
  /** In the order they were added. */
  list(familyId: FamilyId): Promise<Source[]>;
  listOfType(sourceTypeId: SourceTypeId): Promise<Source[]>;
  findById(id: SourceId): Promise<Source | null>;
  /** Stores a migrated plain configuration, unless the Source is no longer at `fromVersion`. */
  migrateConfig(id: SourceId, fromVersion: number, plain: PlainConfig, configVersion: number): Promise<void>;
  /** Stores what an Admin edited: the configuration and the polling interval. */
  update(source: Source): Promise<void>;
  /** Records a run that failed, which keeps the state for the next one. */
  recordFailedRun(id: SourceId, at: Date): Promise<void>;
  /** Removes the Source; its Origins and Revisions stay. */
  remove(id: SourceId): Promise<void>;
}

/** A Revision ready to append, checked by the core. */
export type NewRevision = {
  itemKind: ItemKind;
  itemKey: string;
  act: Act;
  fields: Record<string, unknown>;
  sourceTime: Date;
  /** False for a Revision rejected automatically, such as one with invalid fields. */
  accepted: boolean;
};

/** One successful run of a Source, to record at once. */
export type SourceRun = {
  familyId: FamilyId;
  sourceId: SourceId;
  at: Date;
  /** The plugin's state after the run. */
  state: string | null;
  origins: { externalId: string; attributes: Record<string, string>; link: string | null; revisions: NewRevision[] }[];
};

/** What an Item's Revisions add up to, as stored next to them. */
export type ItemProjection = {
  folded: FoldedItem | null;
  /** Instants certainly before and after the Item's time, to find it by; null if it has none. */
  window: { from: Date; to: Date } | null;
};

export type ProjectedItem = { id: ItemId; kind: ItemKind; folded: FoldedItem; links: string[] };

/** Items, as projections of their append-only Revisions (ADR-0009). */
export interface ItemRepository {
  /**
   * Records a run in one transaction: the Origins, their Revisions unless the same Revision is
   * already recorded, and the Source's state. An Item is found by the Source and the Revision's
   * Item key, or created; every Item a new Revision reached is recomputed with `recompute` from all
   * its Revisions.
   */
  recordRun(
    run: SourceRun,
    recompute: (kind: ItemKind, revisions: FoldableRevision[]) => ItemProjection,
  ): Promise<void>;
  /**
   * The Family's Items whose window overlaps the given time, with the links of their Origins; a
   * `to` of null means all of the future.
   */
  overlapping(familyId: FamilyId, from: Date, to: Date | null): Promise<ProjectedItem[]>;
}

export interface JobQueue {
  send(name: string, data: object): Promise<void>;
  work(name: string, handler: (data: unknown) => Promise<void>): Promise<void>;
}
