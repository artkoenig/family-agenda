import type {
  Act,
  Admin,
  DateMention,
  BlobRef,
  AdminId,
  Email,
  FamilyId,
  FamilyLanguages,
  FamilyMember,
  FamilyMemberId,
  FoldableRevision,
  FoldedItem,
  ItemId,
  ItemKind,
  LocalDate,
  LocalTime,
  OcrLanguage,
  RawMessageId,
  SourceId,
  SourceTypeId,
  View,
  ViewId,
} from "@family-agenda/domain";

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
  languages(id: FamilyId): Promise<FamilyLanguages>;
  saveLanguages(id: FamilyId, languages: FamilyLanguages): Promise<void>;
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

export type IngestedAttachment = { filename: string; contentType: string; bytes: Uint8Array };

/** A message to extract Items from, as a plugin emits it. */
export type IngestedMessage = { text: string; attachments: IngestedAttachment[]; thread: string | null };

/**
 * An Origin as a plugin emits it: structured Revisions, or a raw message whose Revisions
 * extraction adds later.
 */
export type IngestedOrigin = {
  externalId: string;
  /** The source time of its Revisions; for a message, the time it was sent. */
  occurredAt: Date;
  attributes: Record<string, string>;
  link: string | null;
  revisions: IngestedRevision[];
  message: IngestedMessage | null;
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
  /** Whether its Items show on the timeline and in the feeds; a hidden Source is still read. */
  shown: boolean;
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
  /** Shows or hides the Source's Items on the timeline and in the feeds. */
  setShown(id: SourceId, shown: boolean): Promise<void>;
  /**
   * Removes the Source in one transaction with its Origins, raw messages, Revisions and Items.
   * Returns the BlobStore files of its raw messages, for the caller to remove.
   */
  remove(id: SourceId): Promise<BlobRef[]>;
}

/** Why a Revision was rejected automatically (ADR-0009). */
export type Rejection = "invalid-fields" | "evidence-not-found" | "weekday-mismatch" | "no-date";

/** A Revision ready to append, checked by the core. */
export type NewRevision = {
  itemKind: ItemKind;
  itemKey: string;
  act: Act;
  fields: Record<string, unknown>;
  sourceTime: Date;
  /** False for a Revision rejected automatically, such as one with invalid fields. */
  accepted: boolean;
  /** Why it was rejected; null if it was accepted. */
  rejection: Rejection | null;
  /** The words of its message it was extracted from; null for a structured Source. */
  evidence: string | null;
};

/** A file of a raw message, kept in the BlobStore with a hash of its contents (ADR-0006). */
export type StoredFile = { blob: BlobRef; sha256: string; size: number };

/** A raw message as it is recorded, its text and attachments already in the BlobStore. */
export type StoredMessage = {
  text: StoredFile;
  attachments: (StoredFile & { filename: string; contentType: string })[];
  thread: string | null;
};

/** One successful run of a Source, to record at once. */
export type SourceRun = {
  familyId: FamilyId;
  sourceId: SourceId;
  at: Date;
  /** The plugin's state after the run. */
  state: string | null;
  origins: {
    externalId: string;
    /** When it was sent, for a message. */
    occurredAt: Date;
    attributes: Record<string, string>;
    link: string | null;
    revisions: NewRevision[];
    message: StoredMessage | null;
  }[];
};

/** A raw message waiting for its one successful extraction (ADR-0009). */
export type PendingMessage = {
  id: RawMessageId;
  familyId: FamilyId;
  sourceId: SourceId;
  /** The Origin's id within its Source, which keys the Items extracted from it. */
  externalId: string;
  sentAt: Date;
  thread: string | null;
  text: BlobRef;
  /** In the order the message has them. */
  attachments: PendingAttachment[];
};

/** A file of a raw message, which extraction reads too if it is a PDF. */
export type PendingAttachment = { position: number; filename: string; contentType: string; blob: BlobRef };

/** A raw message as an Admin opens it. */
export type RawMessage = {
  id: RawMessageId;
  sourceId: SourceId;
  sentAt: Date;
  attributes: Record<string, string>;
  text: BlobRef;
  attachments: {
    filename: string;
    contentType: string;
    size: number;
    blob: BlobRef;
    /** Why it could not be turned into text when the message was extracted; null if it could, or was not read. */
    conversionProblem: string | null;
  }[];
};

/** An Item that earlier messages of a thread stated, with the key a later one updates it by. */
export type ThreadItem = { itemKey: string; kind: ItemKind; folded: FoldedItem | null };

/** What one successful extraction of a message adds, to record at once. */
export type Extraction = {
  messageId: RawMessageId;
  familyId: FamilyId;
  sourceId: SourceId;
  at: Date;
  revisions: NewRevision[];
  /** The attachments that could not be turned into text, by position, and why. */
  attachmentProblems: AttachmentProblem[];
};

export type AttachmentProblem = { position: number; problem: string };

/** What an Item's Revisions add up to, as stored next to them. */
export type ItemProjection = {
  folded: FoldedItem | null;
  /** Instants certainly before and after the Item's time, to find it by; null if it has none. */
  window: { from: Date; to: Date } | null;
};

export type ProjectedItem = {
  id: ItemId;
  kind: ItemKind;
  folded: FoldedItem;
  links: string[];
  /** The raw messages it was extracted from, oldest first. */
  messages: RawMessageId[];
};

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
  ): Promise<{ knownMessages: string[] }>;
  /** Raw messages not yet extracted successfully, oldest first. */
  pendingMessages(limit: number): Promise<PendingMessage[]>;
  /** The Items earlier messages of a thread in a Source stated, in the order they were created. */
  itemsOfThread(sourceId: SourceId, thread: string): Promise<ThreadItem[]>;
  /**
   * Records a message's extraction in one transaction: its Revisions, appended to its Origin like
   * those of a run, and the message as extracted, so that it is never extracted again.
   */
  recordExtraction(
    extraction: Extraction,
    recompute: (kind: ItemKind, revisions: FoldableRevision[]) => ItemProjection,
  ): Promise<void>;
  findMessage(id: RawMessageId): Promise<RawMessage | null>;
  /**
   * The Family's Items whose window overlaps the given time, with the links of their Origins; a
   * `to` of null means all of the future. Items of a hidden Source are left out.
   */
  overlapping(familyId: FamilyId, from: Date, to: Date | null): Promise<ProjectedItem[]>;
}

/** The one LLM endpoint of the Family, an OpenAI-compatible server. */
export type LlmEndpoint = {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  /** Whether its model reads images, so that scanned pages are sent to it rather than to OCR. */
  vision: boolean;
};

/** The LLM endpoint as stored, its API key in the SecretStore. */
export type StoredLlmEndpoint = {
  familyId: FamilyId;
  baseUrl: string;
  model: string;
  apiKey: SecretRef | null;
  vision: boolean;
  /** When an Admin acknowledged that third parties' messages are sent to it; null for a local one. */
  acknowledgedAt: Date | null;
  savedAt: Date;
};

export interface LlmEndpointRepository {
  find(familyId: FamilyId): Promise<StoredLlmEndpoint | null>;
  save(endpoint: StoredLlmEndpoint): Promise<void>;
}

/** An Event a message states, as the model reads it; code resolves its date and checks it. */
export type ExtractedEvent = {
  /** The `ref` of a known Event of the thread the message changes, moves or cancels; null for a new one. */
  updates: string | null;
  cancelled: boolean;
  /** Null for an update that does not rename it. */
  title: string | null;
  date: DateMention;
  /** `HH:MM`, or null if none is stated. */
  startTime: string | null;
  endTime: string | null;
  place: string | null;
  /** The words of the message that state it, quoted verbatim. */
  evidence: string;
};

/** An Event earlier messages of the thread stated, which the message may update. */
export type KnownEvent = { ref: string; title: string; when: string; place: string | null };

export type ExtractionRequest = {
  endpoint: LlmEndpoint;
  message: {
    text: string;
    /** When it was sent, on the Family's clocks, which relative dates are resolved against. */
    sent: { date: LocalDate; time: LocalTime; weekday: string };
  };
  knownEvents: KnownEvent[];
};

/**
 * The endpoint could not be reached or refused the key, which says nothing about the message;
 * or it answered with output that does not fit the schema.
 */
export type EndpointFailure = { ok: false; problem: "unreachable" | "unauthorized" | "invalid-output"; message: string };

export type ExtractionResult = { ok: true; events: ExtractedEvent[] } | EndpointFailure;

/** Scanned pages of an attachment, as PNG images, for a vision-capable endpoint to read. */
export type TranscriptionRequest = { endpoint: LlmEndpoint; images: Uint8Array[] };

/** The text of each page, in order. */
export type TranscriptionResult = { ok: true; pages: string[] } | EndpointFailure;

/** Reads the Items a message states, and the words of scanned pages, through the Family's LLM endpoint. */
export interface Extractor {
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
  /** Reads the text of scanned pages, word for word, through a vision-capable endpoint. */
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/** What converting a file gave, or why it could not be converted. */
export type Conversion<T> = { ok: true; value: T } | { ok: false; message: string };

/** Turns PDF attachments into text: their text layer, images of their pages, or OCR of a scan. */
export interface TextExtractor {
  /** The text layer of each page, in order; an empty string for a page without one, such as a scan. */
  textLayer(pdf: Uint8Array): Promise<Conversion<string[]>>;
  /** The given pages, numbered from 1, as PNG images. */
  pageImages(pdf: Uint8Array, pages: number[]): Promise<Conversion<Uint8Array[]>>;
  /** The text OCR reads on each of the given pages, numbered from 1, in the given languages, in order. */
  ocr(pdf: Uint8Array, pages: number[], languages: OcrLanguage[]): Promise<Conversion<string[]>>;
}

/** A Tesseract language model in the tessdata volume. */
export type OcrModel = {
  language: OcrLanguage;
  /** Shipped with the image and linked into the volume, so that it cannot be removed. */
  bundled: boolean;
};

/** The Tesseract language models of the Instance, which an Admin can download more of. */
export interface OcrModelStore {
  /** Every language a model can be downloaded for, installed or not. */
  downloadable(): OcrLanguage[];
  /** The models in the volume, bundled, downloaded or put there by hand. */
  installed(): Promise<OcrModel[]>;
  /** Downloads and checks a model; a failed download leaves nothing behind. */
  install(language: OcrLanguage): Promise<Conversion<null>>;
  /** Removes a model that is not bundled. */
  remove(language: OcrLanguage): Promise<void>;
}

export interface JobQueue {
  send(name: string, data: object): Promise<void>;
  work(name: string, handler: (data: unknown) => Promise<void>): Promise<void>;
}

/** What the worker is busy with in the background: running Sources, or extracting messages. */
export type ActivityKind = "polling" | "extracting";

/** The worker's current activity, as far as it got: `done` of `total` Sources or messages. */
export type BackgroundActivity = { kind: ActivityKind; done: number; total: number; updatedAt: Date };

/** The Family's one current background activity, shared between the worker and the api. */
export interface ActivityRepository {
  find(familyId: FamilyId): Promise<BackgroundActivity | null>;
  save(familyId: FamilyId, activity: BackgroundActivity): Promise<void>;
  clear(familyId: FamilyId): Promise<void>;
}
