import type {
  Admin,
  DateMention,
  BlobRef,
  AdminId,
  Email,
  FamilyLanguages,
  FamilyMember,
  FamilyMemberId,
  Event,
  ItemId,
  Lesson,
  LocalDate,
  LocalTime,
  MultilingualText,
  OcrLanguage,
  RawMessageId,
  RunError,
  SourceFailure,
  SourceAttributeId,
  SourceId,
  SourceTypeId,
  StatedTask,
  Task,
  TimetableChange,
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

/** The settings of the Instance's one Family (ADR-0003). */
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
  findByIdentitySubject(subject: string): Promise<Admin | null>;
  list(): Promise<Admin[]>;
  setPasswordHash(id: AdminId, passwordHash: string): Promise<void>;
  /** Links the Admin to the Identity Provider's `sub`, which no other Admin may have. */
  setIdentitySubject(id: AdminId, subject: string): Promise<void>;
}

export interface FamilyMemberRepository {
  add(member: FamilyMember): Promise<void>;
  /** In the order they were added. */
  list(): Promise<FamilyMember[]>;
  findById(id: FamilyMemberId): Promise<FamilyMember | null>;
  /** Stores a changed Family Member that was found before. */
  update(member: FamilyMember): Promise<void>;
  /**
   * Removes the Family Member, and with them the Agendas they were the only member of, and their
   * share of the Source Attributes assigned to others too. The schema refuses while a Source
   * Attribute is assigned to them alone; the result then names those, in the order of their Sources.
   */
  remove(id: FamilyMemberId): Promise<{ removed: true } | { removed: false; blocking: SoleAssignment[] }>;
}

/** A Source Attribute assigned to one Family Member alone. */
export type SoleAssignment = { sourceId: SourceId; attribute: string };

export interface AgendaRepository {
  add(agenda: Agenda): Promise<void>;
  /**
   * In the order they were created, each with its Family Members in the order
   * those were added; Family Members removed since are no longer among them.
   */
  list(): Promise<Agenda[]>;
  findById(id: AgendaId): Promise<Agenda | null>;
  /** Stores a changed Agenda that was found before. */
  update(agenda: Agenda): Promise<void>;
  remove(id: AgendaId): Promise<void>;
}

/**
 * Decides whether an Agenda opens, depending on the listener that accepted the request
 * (ADR-0004). On the local listener every Agenda opens, until Agenda Links are reworked.
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

/** Keeps secrets, such as Source credentials, encrypted at rest (ADR-0003). */
export interface SecretStore {
  put(plaintext: string): Promise<SecretRef>;
  /** The plaintext, or null if no secret has this reference. */
  get(ref: SecretRef): Promise<string | null>;
  remove(ref: SecretRef): Promise<void>;
  /** Every secret it holds, with when it was stored. */
  list(): Promise<{ ref: SecretRef; storedAt: Date }[]>;
}

/** Keeps files, such as photos and attachments, outside Postgres (ADR-0003). */
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
  /** Why the core cannot reach the plugin's container now, such as a refused connection; null if it can, or for a plugin in-process. */
  notReachable: string | null;
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
  /** Its value is a host the plugin connects to, which the plugin's egress proxy allows. */
  host: boolean;
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
  /** Every entry, or why asking the plugin for them failed. */
  entries(): Promise<PluginAnswer<CatalogueEntrySpec[]>>;
};

/** What a plugin is given for one run of a Source. */
export type SourceRunContext = {
  plain: PlainConfig;
  secrets: Record<string, string>;
  syncCursor: string | null;
  now: Date;
  timeZone: string;
};

/** The Item a calendar or timetable entry states, as JSON the way its plugin states it, with its `kind`. */
export type StatedJson = Record<string, unknown>;

export type IngestedAttachment = { filename: string; contentType: string; bytes: Uint8Array };

/** A message to extract Items from, as a plugin emits it. */
export type IngestedMessage = { text: string; attachments: IngestedAttachment[] };

/**
 * An Origin as a plugin emits it: an entry stating its one Item, or a raw message whose Items
 * extraction writes later.
 */
export type IngestedOrigin = {
  externalId: string;
  /** When the Source received a message; null for a stated Item. */
  occurredAt: Date | null;
  /** The external ids of the Source Attributes it names; none withdraws it. */
  attributes: string[];
  /** Who sent a message, if the plugin tells. */
  sender: string | null;
  subject: string | null;
  link: string | null;
  /** The Item an entry states; null for a message. */
  stated: StatedJson | null;
  message: IngestedMessage | null;
};

export type SourceRunResult =
  /** `withdrawn` are the external ids of Origins the Source deleted since, such as redacted messages. */
  /** `secrets` are the secret fields the plugin changed, such as a refreshed token, if any. */
  | { ok: true; origins: IngestedOrigin[]; syncCursor: string | null; withdrawn: string[]; secrets?: Record<string, string> }
  /** A definite error needs an Admin; a temporary one is retried. */
  | { ok: false; kind: "definite" | "temporary"; message: string };

/** A subdivision of a Source as its plugin declares it. */
export type DeclaredAttribute = { externalId: string; name: string };

/**
 * What a plugin reports the Source Attributes of its Source through, while it runs. A call takes
 * effect when it returns, whether or not the run goes on to succeed.
 */
export type AttributeReporting = {
  /** Inserts them; a known id gets the new name and is revived, keeping its assignment. */
  declare(attributes: DeclaredAttribute[]): Promise<void>;
  /** Archives one, keeping its assignment and the Items it decided. */
  archive(externalId: string): Promise<void>;
};

export type PollingIngestion = {
  mode: "polling";
  suggestedIntervalSeconds: number;
  /** Runs the plugin; a plugin that throws or emits invalid Origins fails the run. */
  poll(context: SourceRunContext, attributes: AttributeReporting): Promise<SourceRunResult>;
};

/**
 * A Source Type whose Sources are not polled: something outside the core pushes payloads to it
 * for a Source, and the core hands each to the plugin, recording what it emits as for a poll.
 */
export type PushIngestion = {
  mode: "push";
  /** Hands the plugin a payload pushed to the core for a Source; fails like a poll. */
  receive(context: SourceRunContext, payload: Uint8Array, attributes: AttributeReporting): Promise<SourceRunResult>;
};

/** What the core needs of a loaded plugin; it never asks which one it is. */
export type LoadedSourceType = {
  configuration: {
    version: number;
    fields: ConfigFieldSpec[];
  };
  /** Interactive steps the form shows, such as pairing an account by QR code. */
  setupSteps: SetupStepSpec[];
  /** The plain configuration of `fromVersion` migrated to the current version; rejects if the plugin cannot. */
  migrateConfig: (plain: PlainConfig, fromVersion: number) => Promise<PlainConfig>;
  ingestion: PollingIngestion | PushIngestion;
  /** Whether its Sources count as Silent when no new Origin comes for a while. */
  silentApplies: boolean;
  /** What an Admin enables within it, such as Messengers; null if it has none. */
  catalogue: CatalogueSpec | null;
  /** The values a choice field offers for an existing Source, or why asking the plugin failed. */
  choices(key: string, context: SourceRunContext): Promise<PluginAnswer<KnownValue[]>>;
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

/** What a plugin answered, or why asking it failed, in words an Admin can act on. */
export type PluginAnswer<T> = { ok: true; value: T } | { ok: false; message: string };

/** What the plugin answered, or `fallback` where asking it failed. */
export function valueOr<T>(answer: PluginAnswer<T>, fallback: T): T {
  return answer.ok ? answer.value : fallback;
}

/** A value a plugin offers, such as a chat for a choice field, with how the plugin names it. */
export type KnownValue = { value: string; label: string };

/** The Source plugins discovered at startup (ADR-0001). */
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
  /** Its Source Attributes as its plugin reported them, archived ones too, by name. */
  attributes: SourceAttribute[];
  /** When the worker last ran it, successfully or not; null before its first run, or after an Admin changed it. */
  lastRunAt: Date | null;
  /** When it last ran successfully; null before then. */
  lastSuccessAt: Date | null;
  /** Its failed runs since the last successful one; null if the last run succeeded. */
  failure: SourceFailure | null;
  /** When its last Origin not seen before came; null before the first. */
  lastNewRecordAt: Date | null;
  /** The external ids of its Source Records whose stated Item was invalid, so that none was written. */
  invalidRecords: string[];
  /** The Source Attribute ids that Source Records named without their being declared, or after they were archived. */
  unknownAttributes: string[];
  createdAt: Date;
};

/** A subdivision of a Source that its plugin reported (ADR-0005), and the Family Members an Admin assigned to it. */
export type SourceAttribute = {
  id: SourceAttributeId;
  externalId: string;
  name: string;
  /** Archived by its plugin: it keeps its assignment and the Items it decided, but no Source Record can name it. */
  archived: boolean;
  /** The Family Members assigned to it, in the Family's order, whom the Items of its Source Records concern; none for the whole Family. */
  concerns: FamilyMemberId[];
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
  /** Points the Source's secret fields at these references, such as after its plugin refreshed a token. */
  replaceSecrets(id: SourceId, secrets: Record<string, SecretRef>): Promise<void>;
  /** Shows or hides the Source's Items on the timeline and in the feeds. */
  setShown(id: SourceId, shown: boolean): Promise<void>;
  /** Names the Source as an Admin calls it; null for the name derived from its settings. */
  rename(id: SourceId, name: string | null): Promise<void>;
  /**
   * Makes the Source Attributes known on a plugin's behalf, in one transaction: an unknown id is
   * inserted, a known one gets its name and is revived. The ids no longer count as unknown on the
   * Source's run state.
   */
  declareAttributes(id: SourceId, attributes: DeclaredAttribute[]): Promise<void>;
  /** Archives a Source Attribute by its external id; an unknown one is ignored. */
  archiveAttribute(id: SourceId, externalId: string): Promise<void>;
  /**
   * Assigns the Source Attribute to the Family Members, replacing those it was assigned to; none
   * for the whole Family. Returns whether the Source Attribute exists.
   */
  assignAttribute(id: SourceAttributeId, concerns: FamilyMemberId[]): Promise<boolean>;
  /**
   * Removes the Source in one transaction with its Source Records and their Items. Returns the
   * BlobStore files of its messages' attachments, for the caller to remove.
   */
  remove(id: SourceId): Promise<BlobRef[]>;
}

/** The one Item a calendar, timetable or list of Tasks entry states, checked and ready to write. */
export type StatedItem =
  | { kind: "event"; event: Event }
  | { kind: "lesson"; lesson: Omit<Lesson, "cancelled">; change: StoredChange | null }
  | { kind: "task"; task: StatedTask };

/** A Lesson's Timetable Change as it is stored on the Lesson. */
export type StoredChange = Pick<TimetableChange, "change" | "previousRoom" | "previousTeacher" | "note">;

/** The Item an entry states, or why it is none. */
export type ReadStated = (stated: StatedJson) => { ok: true; item: StatedItem } | { ok: false; problems: string[] };

/** A Source Record whose stated Item was not written, and why. */
export type InvalidRecord = { externalId: string; problems: string[] };

/** A file of a raw message, kept in the BlobStore with a hash of its contents (ADR-0003). */
export type StoredFile = { blob: BlobRef; sha256: string; size: number };

/** A message as it is recorded: its text, and its attachments already in the BlobStore. */
export type StoredMessage = {
  sender: string | null;
  subject: string | null;
  body: string;
  attachments: (StoredFile & { filename: string; contentType: string })[];
};

/** One successful run of a Source, to record at once. */
export type SourceRun = {
  sourceId: SourceId;
  at: Date;
  /** Where the plugin resumes on its next run, stored only together with the run's Origins. */
  syncCursor: string | null;
  /** Messages received before this are ignored, whatever the Source delivers: they are past retention. */
  retainedSince: Date;
  /** External ids of Origins the Source deleted, whose Items are deleted and whose messages go. */
  withdrawn: string[];
  origins: {
    externalId: string;
    /** When the Source received a message; null for a stated Item. */
    occurredAt: Date | null;
    /**
     * The external ids of the Source Attributes it names. Naming one that is unknown or archived
     * refuses the Origin; an empty list withdraws it.
     */
    attributes: string[];
    sender: string | null;
    subject: string | null;
    link: string | null;
    /** The Item an entry states, as its plugin states it; null for a message. */
    stated: StatedJson | null;
    message: StoredMessage | null;
  }[];
};

/** What recording a run found out, for the caller to act on. */
export type RunRecorded = {
  knownMessages: string[];
  withdrawnFiles: BlobRef[];
  invalid: InvalidRecord[];
  /** The Source Attribute ids that Origins named without being declared, or after they were archived. */
  refused: string[];
};

/** A raw message waiting for its one successful extraction (ADR-0005). */
export type PendingMessage = {
  id: RawMessageId;
  sourceId: SourceId;
  sentAt: Date;
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
  sender: string | null;
  subject: string | null;
  /** The names of its Source Attributes. */
  attributes: string[];
  /** Empty once purged. */
  body: string;
  /** When its content was deleted after the retention period or because nothing needed it; null while it is kept. */
  purgedAt: Date | null;
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

/** An Item a message states, checked and ready to write. */
export type NewItem = { kind: "event"; event: Event } | { kind: "task"; task: StatedTask };

/** What one successful extraction of a message writes, to record at once. */
export type Extraction = {
  messageId: RawMessageId;
  at: Date;
  items: NewItem[];
  /** The attachments that could not be turned into text, by position, and why. */
  attachmentProblems: AttachmentProblem[];
};

export type AttachmentProblem = { position: number; problem: string };

/** An Item with what it is, by its kind. */
export type ItemDetails =
  | { kind: "event"; event: Event }
  | { kind: "task"; task: Task }
  | { kind: "lesson"; lesson: Lesson; change: TimetableChange | null };

export type ProjectedItem = ItemDetails & {
  id: ItemId;
  /** Where its Source Record can be looked at, with the Source Type and name of its Source. */
  links: { url: string; sourceTypeId: SourceTypeId; sourceName: string | null }[];
  /** The message it was extracted from, if any, with the Source Type and name of its Source. */
  messages: { id: RawMessageId; sourceTypeId: SourceTypeId; sourceName: string | null; sentAt: Date }[];
  /**
   * The Family Members assigned to each Source Attribute of its Source Record, in the Family's
   * order; an empty list for one assigned to no one. They decide whom it concerns.
   */
  assignments: FamilyMemberId[][];
};

/** Items, each written from its one Source Record (ADR-0005). */
export interface ItemRepository {
  /**
   * Records a run in one transaction: its Source Records, the one Item of each calendar or
   * timetable entry, and the Source's sync cursor. An entry whose stated Item is unchanged is not
   * written at all; a changed one overwrites its Item, read with `read`, and one that is invalid,
   * by `read` or by a check of the schema, writes none and is kept among the Source's invalid
   * records. A withdrawn Source Record's Items are deleted and its message's text and attachments
   * removed. Arriving again, it is no longer withdrawn: an entry writes its Item as new, but a
   * message is not recorded or read again. Returns the external ids of messages recorded before or
   * withdrawn, whose new attachments the caller removes, the attachments of the withdrawn
   * messages, for the caller to remove, and the entries whose Item was invalid.
   *
   * An Origin naming a Source Attribute that is unknown or archived is refused, as a plugin bug:
   * it is not recorded, and the ids are returned and kept among the Source's unknown attributes
   * until a run refuses nothing or a declare covers them. One recorded again with another list of
   * Source Attributes moves to it without being read again; one with an empty list is withdrawn.
   */
  recordRun(run: SourceRun, read: ReadStated): Promise<RunRecorded>;
  /**
   * Deletes the text and attachments of messages nothing needs any more, or that arrived before
   * `retainedSince`, leaving a tombstone, and deletes the rows of those older than that without
   * an Item. A message not extracted yet is kept until it is older than `retainedSince`. Returns
   * the files of the removed attachments, for the caller to remove.
   */
  purgeMessages(now: Date, retainedSince: Date): Promise<{ files: BlobRef[]; purged: number; deleted: number }>;
  /** Raw messages not yet extracted successfully, oldest first. */
  pendingMessages(limit: number): Promise<PendingMessage[]>;
  /** How many raw messages, of one Source or of all, wait for extraction. */
  pendingMessageCount(scope: { sourceId?: SourceId }): Promise<number>;
  /**
   * Records a message's one extraction in one transaction: its Items, and the message as
   * extracted, so that it is never read again. A message extracted already is left as it is.
   */
  recordExtraction(extraction: Extraction): Promise<void>;
  findMessage(id: RawMessageId): Promise<RawMessage | null>;
  /** The Items written from a message, in the order they were, also those of a hidden Source. */
  itemsOfMessage(id: RawMessageId): Promise<ProjectedItem[]>;
  /**
   * The Family's Items that may touch the given time, with the link of their Source Record; a
   * `to` of null means all of the future. Items of a hidden Source are left out.
   */
  overlapping(from: Date, to: Date | null): Promise<ProjectedItem[]>;
  /** The Family's Tasks not done yet, whatever their time, as `overlapping` gives them. */
  outstanding(): Promise<ProjectedItem[]>;
  /** The Item as `overlapping` gives it, or null if there is none or it is not shown. */
  find(id: ItemId): Promise<ProjectedItem | null>;
  /** Ticks a Task done at `at`, or takes the tick back with null. */
  setTaskDone(id: ItemId, at: Date | null): Promise<void>;
  /** Deletes the Item, which nothing remembers. Returns whether there was one. */
  remove(id: ItemId): Promise<boolean>;
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

/** The Identity Provider as stored, its client secret in the SecretStore. */
export type StoredIdentityProvider = {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: SecretRef | null;
  requiredGroup: string;
  /** The origin Admins reach the Instance at for single sign-on, such as `https://agenda.example.ts.net`. */
  publicBaseUrl: string;
  savedAt: Date;
};

export interface IdentityProviderRepository {
  find(): Promise<StoredIdentityProvider | null>;
  save(provider: StoredIdentityProvider): Promise<void>;
}

/** What it takes to talk to an OIDC Identity Provider as the Instance's client. */
export type IdentityProviderConnection = {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
};

/** What the Instance remembers between sending an Admin to the Identity Provider and their return. */
export type PendingSignIn = {
  state: string;
  nonce: string;
  codeVerifier: string;
};

/** Who the Identity Provider says has signed in. */
export type VerifiedIdentity = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  groups: string[];
};

/** An OIDC client: authorization code flow with PKCE, scopes `openid email profile groups`. */
export interface IdentityProviderClient {
  /** Fetches the provider's discovery document. */
  discover(
    issuerUrl: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  begin(
    connection: IdentityProviderConnection,
    redirectUri: string,
  ): Promise<{ authorizationUrl: string; pending: PendingSignIn }>;
  /** The verified identity for the URL the provider sent the Admin back to, or null if it does not check out. */
  complete(
    connection: IdentityProviderConnection,
    redirectUri: string,
    callbackUrl: string,
    pending: PendingSignIn,
  ): Promise<VerifiedIdentity | null>;
}

/** An Event a message states, as the model reads it; code resolves its date and checks it. */
export type ExtractedEvent = {
  title: string | null;
  date: DateMention;
  /** `HH:MM`, or null if none is stated. */
  startTime: string | null;
  endTime: string | null;
  place: string | null;
  /** The words of the message that state it, quoted verbatim. */
  evidence: string;
};

/**
 * A Task a message states, as the model reads it: something to do or bring, a packing list being
 * one Task with its things to bring. Code resolves its Deadline and checks it.
 */
export type ExtractedTask = {
  title: string | null;
  /** The Deadline as the message words it; every part null if it states none. */
  deadline: DateMention;
  /** The things to bring; none if it states none. */
  bring: string[];
  /** The words of the message that state it, quoted verbatim. */
  evidence: string;
};

export type ExtractionRequest = {
  endpoint: LlmEndpoint;
  message: {
    text: string;
    /** When it was sent, on the Family's clocks, which relative dates are resolved against. */
    sent: { date: LocalDate; time: LocalTime; weekday: string };
  };
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
