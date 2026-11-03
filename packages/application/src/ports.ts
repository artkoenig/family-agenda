import type {
  Act,
  Admin,
  DateMention,
  BlobRef,
  AdminId,
  Email,
  FamilyLanguages,
  FamilyMember,
  FamilyMemberId,
  FoldableRevision,
  FoldedItem,
  ItemId,
  ItemKind,
  LocalDate,
  LocalTime,
  MultilingualText,
  OcrLanguage,
  RawMessageId,
  RevisionAuthor,
  RunError,
  SourceFailure,
  SourceId,
  SourceTypeId,
  Agenda,
  AgendaId,
} from "@family-agenda/domain";

export interface Clock {
  now(): Date;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

/** The settings of the Instance's one Family (ADR-0013). */
export interface FamilyRepository {
  recoveryKitConfirmed(): Promise<boolean>;
  /** Keeps the first confirmation if there is one. */
  confirmRecoveryKit(at: Date): Promise<void>;
  languages(): Promise<FamilyLanguages>;
  saveLanguages(languages: FamilyLanguages): Promise<void>;
  /** Whether OCR reads the scanned pages of attachments. */
  ocrEnabled(): Promise<boolean>;
  saveOcrEnabled(enabled: boolean): Promise<void>;
}

export interface AdminRepository {
  exists(): Promise<boolean>;
  /** Adds the Admin only if no Admin exists yet. Returns whether it was added. */
  addFirst(admin: Admin): Promise<boolean>;
  /** Returns false if the email is taken. */
  add(admin: Admin): Promise<boolean>;
  findById(id: AdminId): Promise<Admin | null>;
  findByEmail(email: Email): Promise<Admin | null>;
  list(): Promise<Admin[]>;
  setPasswordHash(id: AdminId, passwordHash: string): Promise<void>;
}

export interface FamilyMemberRepository {
  add(member: FamilyMember): Promise<void>;
  /** In the order they were added. */
  list(): Promise<FamilyMember[]>;
  findById(id: FamilyMemberId): Promise<FamilyMember | null>;
  /** Stores a changed Family Member that was found before. */
  update(member: FamilyMember): Promise<void>;
  remove(id: FamilyMemberId): Promise<void>;
}

export interface AgendaRepository {
  add(agenda: Agenda): Promise<void>;
  /**
   * In the order they were created, each with its preselected Family Members in the order
   * those were added; Family Members removed since are no longer preselected.
   */
  list(): Promise<Agenda[]>;
  findById(id: AgendaId): Promise<Agenda | null>;
  /** Stores a changed Agenda that was found before. */
  update(agenda: Agenda): Promise<void>;
  remove(id: AgendaId): Promise<void>;
}

/**
 * Decides whether an Agenda opens, depending on the listener that accepted the request
 * (ADR-0005). On the local listener every Agenda opens (ADR-0003).
 */
export interface AgendaAccessPolicy {
  mayOpen(agenda: AgendaId): Promise<boolean>;
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
  /** Removes the sessions that expired at `now` or before. */
  removeExpired(now: Date): Promise<void>;
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
  /** Every secret it holds, with when it was stored. */
  list(): Promise<{ ref: SecretRef; storedAt: Date }[]>;
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
  displayName: MultilingualText;
  description: MultilingualText;
  /** The plugin's version. */
  version: string;
  needsLlm: boolean;
  /** Shown before an Admin can enable it; null if there is none. */
  riskNotice: MultilingualText | null;
  /** Why the plugin cannot be loaded, such as an incompatible SDK version; null if it can. */
  notLoadable: string | null;
};

/** A plain configuration, as JSON. */
export type PlainConfig = Record<string, unknown>;

/** One field of a Source's configuration, as the Admin area renders it. */
export type ConfigFieldSpec = {
  key: string;
  label: MultilingualText;
  secret: boolean;
  required: boolean;
  description: MultilingualText | null;
  /** Set by the plugin when the Source is added, never by an Admin. */
  setByPlugin: boolean;
  /** A choice among values the plugin offers for an existing Source; its value is the list of the chosen ones. */
  choice: boolean;
  /** A list of names an Admin types, each a Part of the Source that is assigned on its own. */
  parts: boolean;
};

/** An interactive step of a Source's form, as a plugin declares it. */
export type SetupStepSpec = {
  id: string;
  title: MultilingualText;
  description: MultilingualText;
  /** Driven live for an existing Source, such as a QR code login, through `setupProgress`. */
  live: boolean;
};

/** What a live setup step shows now. */
export type SetupProgress =
  | { status: "waiting"; qrCode: string | null; message: MultilingualText | null }
  | { status: "done"; message: MultilingualText | null }
  | { status: "failed"; message: MultilingualText };

/** An entry of a Source Type's catalogue, such as a Messenger, as its plugin lists it. */
export type CatalogueEntrySpec = {
  id: string;
  displayName: MultilingualText;
  description: MultilingualText;
  installed: boolean;
  riskNotice: MultilingualText | null;
};

/** What an Admin enables one by one within a Source Type; each Source uses one entry. */
export type CatalogueSpec = {
  title: MultilingualText;
  /** The plain field naming the entry a Source uses. */
  configKey: string;
  /** Every entry; none if asking the plugin failed. */
  entries(): Promise<CatalogueEntrySpec[]>;
};

/** Programs a Source Type runs on the Instance, which the worker reconciles with what is enabled. */
export type ServicesSpec = {
  /** Starts what is enabled and stops the rest; `entries` are the enabled catalogue entries. */
  reconcile(enabled: { enabled: boolean; entries: string[] }): Promise<void>;
  stop(): Promise<void>;
};

/** What a plugin is given for one run of a Source. */
export type SourceRunContext = {
  plain: PlainConfig;
  secrets: Record<string, string>;
  syncCursor: string | null;
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
  /** The Part of the Source it came from, such as a mail's folder; null if it has none. */
  part: string | null;
  revisions: IngestedRevision[];
  message: IngestedMessage | null;
};

export type SourceRunResult =
  /** `withdrawn` are the external ids of Origins the Source deleted since, such as redacted messages. */
  | { ok: true; origins: IngestedOrigin[]; syncCursor: string | null; withdrawn: string[] }
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
  /** Interactive steps the form shows, such as pairing an account by QR code. */
  setupSteps: SetupStepSpec[];
  /** The plain configuration of `fromVersion` migrated to the current version. */
  migrateConfig: (plain: PlainConfig, fromVersion: number) => PlainConfig;
  ingestion: PollingIngestion | { mode: "push" };
  /** Whether its Sources count as Silent when no new Origin comes for a while. */
  silentApplies: boolean;
  /** What an Admin enables within it, such as Messengers; null if it has none. */
  catalogue: CatalogueSpec | null;
  /** Programs it runs on the Instance while enabled, such as a homeserver; null if it has none. */
  services: ServicesSpec | null;
  /** The values a choice field offers for an existing Source; none if asking the plugin failed. */
  choices(key: string, context: SourceRunContext): Promise<KnownValue[]>;
  /** What a live setup step of an existing Source shows now. */
  setupProgress(stepId: string, context: SourceRunContext): Promise<SetupProgress>;
  /**
   * Prepares a Source being added, such as by creating an account for it; returns the values of
   * the fields the plugin sets, or why the Source cannot be added.
   */
  sourceAdded(
    context: Omit<SourceRunContext, "syncCursor">,
  ): Promise<{ ok: true; plain: PlainConfig; secrets: Record<string, string> } | { ok: false; message: string }>;
  /** Cleans up after a removed Source; failures are ignored. */
  sourceRemoved(context: SourceRunContext): Promise<void>;
};

/** A value a plugin offers, such as a chat for a choice field, with how the plugin names it. */
export type KnownValue = { value: string; label: string };

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
};

/** What the Instance stores per entry of a Source Type's catalogue. */
export type CatalogueRecord = {
  entryId: string;
  enabled: boolean;
  /** How often the Sources using it are polled; null for their plugin's suggestion. */
  pollIntervalSeconds: number | null;
};

export interface CatalogueRepository {
  /** Records the entries not stored yet as disabled; keeps the others as they are. */
  recordDiscovered(sourceTypeId: SourceTypeId, entryIds: string[]): Promise<void>;
  list(sourceTypeId: SourceTypeId): Promise<CatalogueRecord[]>;
  enable(sourceTypeId: SourceTypeId, entryId: string): Promise<void>;
  setPollInterval(sourceTypeId: SourceTypeId, entryId: string, seconds: number | null): Promise<void>;
  /**
   * Disables the entry unless a Source of the Source Type names it in its plain `configKey`
   * field. Returns whether it is disabled now.
   */
  disableIfUnused(sourceTypeId: SourceTypeId, entryId: string, configKey: string): Promise<boolean>;
}

export interface SourceTypeRepository {
  /** Records the ids not stored yet as disabled; keeps the others as they are. */
  recordDiscovered(ids: SourceTypeId[]): Promise<void>;
  list(): Promise<SourceTypeRecord[]>;
  enable(id: SourceTypeId): Promise<void>;
  /** Disables the Source Type unless it has Sources. Returns whether it did. */
  disableIfUnused(id: SourceTypeId): Promise<boolean>;
}

export type Source = {
  id: SourceId;
  sourceTypeId: SourceTypeId;
  plain: PlainConfig;
  /** The configuration version of the plugin the plain configuration was stored with. */
  configVersion: number;
  /** Where each secret field's value is kept in the SecretStore. */
  secrets: Record<string, SecretRef>;
  /** Where the plugin resumes on its next run, such as a sync token; opaque to the Instance. */
  syncCursor: string | null;
  /** How often the worker polls it, as an Admin set it; null for the plugin's suggestion. */
  pollIntervalSeconds: number | null;
  /** Whether its Items show on the timeline and in the feeds; a hidden Source is still read. */
  shown: boolean;
  /** As an Admin named it, such as "Class 3b"; null for the name the Admin area derives from its settings. */
  name: string | null;
  /**
   * The Family Members an Admin assigned it to, in the Family's order, whom its Items concern;
   * none for the whole Family. Family Members removed since are no longer listed.
   */
  concerns: FamilyMemberId[];
  /**
   * The Family Members an Admin assigned each of its Parts to, in the Family's order, by the
   * Part's name, such as a mail folder's; a Part not listed here concerns those the Source is
   * assigned to, or the whole Family.
   */
  partConcerns: Record<string, FamilyMemberId[]>;
  /** When the worker last ran it, successfully or not; null before its first run, or after an Admin changed it. */
  lastRunAt: Date | null;
  /** When it last ran successfully; null before then. */
  lastSuccessAt: Date | null;
  /** Its failed runs since the last successful one; null if the last run succeeded. */
  failure: SourceFailure | null;
  /** When its last Origin not seen before came; null before the first. */
  lastNewOriginAt: Date | null;
  createdAt: Date;
};

export interface SourceRepository {
  add(source: Source): Promise<void>;
  /** In the order they were added. */
  list(): Promise<Source[]>;
  listOfType(sourceTypeId: SourceTypeId): Promise<Source[]>;
  findById(id: SourceId): Promise<Source | null>;
  /** Stores a migrated plain configuration, unless the Source is no longer at `fromVersion`. */
  migrateConfig(id: SourceId, fromVersion: number, plain: PlainConfig, configVersion: number): Promise<void>;
  /**
   * Stores what an Admin edited: the configuration, the polling interval, and the time of the last
   * run, which an edit clears so that the Source runs again on the next tick.
   */
  update(source: Source): Promise<void>;
  /**
   * Records a run that failed, which keeps the sync cursor for the next one. The Source fails since the
   * first failed run after its last successful one, and definitely once any of them did.
   */
  recordFailedRun(id: SourceId, at: Date, error: RunError): Promise<void>;
  /** Shows or hides the Source's Items on the timeline and in the feeds. */
  setShown(id: SourceId, shown: boolean): Promise<void>;
  /** Names the Source as an Admin calls it; null for the name derived from its settings. */
  rename(id: SourceId, name: string | null): Promise<void>;
  /** Assigns the Source to the Family Members, replacing those it was assigned to; none for the whole Family. */
  assign(id: SourceId, concerns: FamilyMemberId[]): Promise<void>;
  /** Assigns each Part of the Source to Family Members, replacing every Part's assignment; a Part with none is left out. */
  assignParts(id: SourceId, parts: Record<string, FamilyMemberId[]>): Promise<void>;
  /**
   * Removes the Source in one transaction with its Origins, raw messages and Revisions, and the
   * Items no other Source names; those another Source names are recomputed with `recompute`.
   * Returns the BlobStore files of its raw messages, for the caller to remove.
   */
  remove(id: SourceId, recompute: (kind: ItemKind, revisions: FoldableRevision[]) => ItemProjection): Promise<BlobRef[]>;
}

/** Why a Revision was rejected automatically (ADR-0009). */
export type Rejection = "invalid-fields" | "evidence-not-found" | "weekday-mismatch" | "no-date" | "origin-withdrawn" | "superseded";

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

/** A message as it is recorded: its text, and its attachments already in the BlobStore. */
export type StoredMessage = {
  sender: string | null;
  subject: string | null;
  body: string;
  attachments: (StoredFile & { filename: string; contentType: string })[];
  thread: string | null;
};

/** One successful run of a Source, to record at once. */
export type SourceRun = {
  sourceId: SourceId;
  at: Date;
  /** Where the plugin resumes on its next run, stored only together with the run's Origins. */
  syncCursor: string | null;
  /** External ids of Origins the Source deleted, whose Revisions are rejected and whose messages go. */
  withdrawn: string[];
  origins: {
    externalId: string;
    /** When the Source received it. */
    occurredAt: Date;
    attributes: Record<string, string>;
    link: string | null;
    /** The Part of the Source it came from; null if it has none. */
    part: string | null;
    revisions: NewRevision[];
    message: StoredMessage | null;
  }[];
};

/** A raw message waiting for its one successful extraction (ADR-0009). */
export type PendingMessage = {
  id: RawMessageId;
  sourceId: SourceId;
  /** The Origin's id within its Source, which keys the Items extracted from it. */
  externalId: string;
  sentAt: Date;
  thread: string | null;
  body: string;
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
  body: string;
  attachments: {
    position: number;
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
  /** Whether it waits for someone to act on it whatever its time, as an undone Task does, to find it by. */
  outstanding: boolean;
};

export type ProjectedItem = {
  id: ItemId;
  kind: ItemKind;
  folded: FoldedItem;
  /** Where its Origins can be looked at, each with the Source Type and name of the Origin's Source. */
  links: { url: string; sourceTypeId: SourceTypeId; sourceName: string | null }[];
  /** The raw messages it was extracted from, oldest first, each with the Source Type and name of its Source. */
  messages: { id: RawMessageId; sourceTypeId: SourceTypeId; sourceName: string | null; sentAt: Date }[];
  /** The Sources, with their Parts, of the Origins whose accepted Revisions it adds up to, which decide whom it concerns. */
  sources: { sourceId: SourceId; part: string | null }[];
};

/** A Revision by someone other than an Origin, such as one ticking a Task done. */
export type AuthoredRevision = {
  act: Act;
  fields: Record<string, unknown>;
  /** When it was made. */
  sourceTime: Date;
  author: Exclude<RevisionAuthor, { kind: "origin" }>;
};

/** Items, as projections of their append-only Revisions (ADR-0009). */
export interface ItemRepository {
  /**
   * Records a run in one transaction: the Origins, their Revisions unless the same Revision is
   * already recorded, and the Source's sync cursor. An Item is found by the Source and the Revision's
   * Item key, or created; every Item a new Revision reached is recomputed with `recompute` from all
   * its Revisions. A withdrawn Source Record's Revisions are rejected and its message's text and
   * attachments are removed. Arriving again, it is no longer withdrawn: its Revisions count again when the
   * Source states them again, but its message is not recorded again.
   * Returns the external ids of messages recorded before or withdrawn, whose new attachments the
   * caller removes, and the attachments of the withdrawn messages, for the caller to remove.
   */
  recordRun(
    run: SourceRun,
    recompute: (kind: ItemKind, revisions: FoldableRevision[]) => ItemProjection,
  ): Promise<{ knownMessages: string[]; withdrawnFiles: BlobRef[] }>;
  /** Raw messages not yet extracted successfully, oldest first. */
  pendingMessages(limit: number): Promise<PendingMessage[]>;
  /**
   * The Items messages of a thread in a Source sent before the given one stated, in the order they
   * were created, each folded with `recompute` from what only those messages and people stated,
   * so that a re-read message sees neither its own Items nor those of later messages.
   */
  itemsOfThread(
    sourceId: SourceId,
    thread: string,
    before: { messageId: RawMessageId; sentAt: Date },
    recompute: (kind: ItemKind, revisions: FoldableRevision[]) => ItemProjection,
  ): Promise<ThreadItem[]>;
  /**
   * Marks the raw messages, of one Source or of all, as not yet extracted, so that they are read
   * again (ADR-0015). Returns how many.
   */
  requestRereading(scope: { sourceId?: SourceId }): Promise<number>;
  /** How many raw messages, of one Source or of all, wait for extraction. */
  pendingMessageCount(scope: { sourceId?: SourceId }): Promise<number>;
  /**
   * Records a message's extraction in one transaction: its Revisions, appended to its Origin like
   * those of a run, and the message as extracted, so that it is not extracted again until asked
   * to. The Revisions the Source Record stated before are superseded first; a new
   * one the same as one of them brings it back.
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
  overlapping(from: Date, to: Date | null): Promise<ProjectedItem[]>;
  /** The Family's outstanding Items, whatever their time, as `overlapping` gives them. */
  outstanding(): Promise<ProjectedItem[]>;
  /** The Item as `overlapping` gives it, or null if there is none or it is not shown. */
  find(id: ItemId): Promise<ProjectedItem | null>;
  /** Appends a Revision to the Item and recomputes it with `recompute`, in one transaction. */
  appendAuthored(
    id: ItemId,
    revision: AuthoredRevision,
    recompute: (kind: ItemKind, revisions: FoldableRevision[]) => ItemProjection,
  ): Promise<void>;
  /** The Item's Revisions by Agendas and Admins, in the order they were made. */
  authoredRevisions(id: ItemId): Promise<AuthoredRevision[]>;
}

/** The one LLM endpoint of the Family, an OpenAI-compatible server. */
export type LlmEndpoint = {
  baseUrl: string;
  model: string;
  apiKey: string | null;
};

/** The LLM endpoint as stored, its API key in the SecretStore. */
export type StoredLlmEndpoint = {
  baseUrl: string;
  model: string;
  apiKey: SecretRef | null;
  /** When an Admin acknowledged that third parties' messages are sent to it; null for a local one. */
  acknowledgedAt: Date | null;
  savedAt: Date;
};

export interface LlmEndpointRepository {
  find(): Promise<StoredLlmEndpoint | null>;
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

/**
 * A Task a message states, as the model reads it: something to do or bring, a packing list being
 * one Task with its things to bring. Code resolves its Deadline and checks it.
 */
export type ExtractedTask = {
  /** The `ref` of a known Task of the thread the message changes or cancels; null for a new one. */
  updates: string | null;
  cancelled: boolean;
  /** Null for an update that does not rename it. */
  title: string | null;
  /** The Deadline as the message words it; every part null if it states none. */
  deadline: DateMention;
  /** The things to bring; none if it states none, or for an update that does not change them. */
  bring: string[];
  /** The words of the message that state it, quoted verbatim. */
  evidence: string;
};

/** A Task earlier messages of the thread stated, which the message may update. */
export type KnownTask = { ref: string; title: string; deadline: LocalDate | null; bring: string[] };

export type ExtractionRequest = {
  endpoint: LlmEndpoint;
  message: {
    text: string;
    /** When it was sent, on the Family's clocks, which relative dates are resolved against. */
    sent: { date: LocalDate; time: LocalTime; weekday: string };
  };
  knownEvents: KnownEvent[];
  knownTasks: KnownTask[];
};

/**
 * The endpoint could not be reached or refused the key, which says nothing about the message;
 * or it answered with output that does not fit the schema.
 */
export type EndpointFailure = { ok: false; problem: "unreachable" | "unauthorized" | "invalid-output"; message: string };

export type ExtractionResult = { ok: true; events: ExtractedEvent[]; tasks: ExtractedTask[] } | EndpointFailure;

/** Reads the Items a message states through the Family's LLM endpoint. */
export interface Extractor {
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
  /** Whether the endpoint answers, and why not if it does not. */
  health(endpoint: LlmEndpoint): Promise<EndpointHealth>;
  /** The ids of the models the endpoint offers; none if it cannot be asked. */
  models(endpoint: LlmEndpoint): Promise<string[]>;
}

export type EndpointHealth = { ok: true } | { ok: false; message: string };

/** What converting a file gave, or why it could not be converted. */
export type Conversion<T> = { ok: true; value: T } | { ok: false; message: string };

/** Turns PDF attachments into text: their text layer, or OCR of a scan. */
export interface TextExtractor {
  /** The text layer of each page, in order; an empty string for a page without one, such as a scan. */
  textLayer(pdf: Uint8Array): Promise<Conversion<string[]>>;
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
  /** Removes a model that is not bundled; a bundled or missing one is left alone. */
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
  find(): Promise<BackgroundActivity | null>;
  save(activity: BackgroundActivity): Promise<void>;
  clear(): Promise<void>;
}
