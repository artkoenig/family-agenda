import { randomBytes } from "node:crypto";
import { endpoints } from "@family-agenda/plugin-contract";
import { mkdir } from "node:fs/promises";
import {
  CommandLineTextExtractor,
  connectPostgres,
  createMasterKey,
  EnvelopeSecretStore,
  FileBlobStore,
  holdsSecrets,
  isSchemaCurrent,
  migrationsFolder,
  refuseNewerMigrationHistory,
  refuseOldMigrationHistory,
  storedFamilyId,
  FamilyIdConflictError,
  OpenAiCompatibleExtractor,
  PgBossWorkRunner,
  PostgresActivityRepository,
  PostgresAdminSessionRepository,
  PostgresCatalogueRepository,
  PostgresFamilyMemberRepository,
  PostgresFamilyRepository,
  PostgresItemRepository,
  PostgresLlmEndpointRepository,
  PostgresProcessedEventRepository,
  OidcIdentityProviderClient,
  LogtoIdentityDirectory,
  PostgresSourceAddingRepository,
  PostgresSourceRunTurns,
  PostgresSourceRepository,
  PostgresSourceTypeRepository,
  PostgresAgendaRepository,
  readMasterKey,
  runMigrations,
  SystemClock,
  TessdataDirectory,
  tessdataFastCatalog,
  type FamilyId,
  type PostgresConnection,
  type TessdataCatalog,
} from "@family-agenda/adapters";
import {
  createActivityLog,
  createAdminAccess,
  createCatalogueAccess,
  createExtraction,
  createFamilyMemberAccess,
  createLanguageAccess,
  createLlmEndpointAccess,
  createSingleSignOn,
  createFamilyAdmins,
  createInvitationAcceptance,
  type InvitationAcceptance,
  type FamilyAdmins,
  createMessageAccess,
  createRecoveryKitAccess,
  createRetention,
  createSecretSweep,
  createDueWork,
  createCache,
  createSourceAccess,
  createSourceHealth,
  createSourcePolling,
  createSourceTypeAccess,
  createTaskAccess,
  createAgendaAccess,
  createRegistrationEvents,
  createFamilyRegistration,
  noRegistration,
  type IdentityDirectory,
  type IdentityDirectorySettings,
  type Registration,
  type RegistrationEvents,
  type AdminAccess,
  type Cached,
  type CatalogueAccess,
  type TurnTimings,
  type BlobStore,
  type ExtractionAccess,
  type Extractor,
  type FamilyMemberAccess,
  type Clock,
  type LanguageAccess,
  type IdentityProviderClient,
  type IdentityProviderSettings,
  type LlmEndpoint,
  type LlmEndpointAccess,
  type SingleSignOn,
  type MessageAccess,
  type RecoveryKitAccess,
  type SecretStore,
  type Retention,
  type SecretSweep,
  type DueWork,
  type WorkRunner,
  type SourceAccess,
  type SourcePolling,
  type SourceTypeAccess,
  type TextExtractor,
  type TaskAccess,
  type AgendaAccess,
} from "@family-agenda/application";
import { startBackgroundWork, type WorkLog } from "./background-work";
import type { PluginBinding } from "./plugin-containers/bindings";
import { PluginContainers } from "./plugin-containers/registry";
import type { PluginContainerOptions } from "./plugin-containers/transport";

/** Where the Instance keeps its data: a Postgres server, or a connection made some other way. */
export type DatabaseConfig =
  | { databaseUrl: string }
  | {
      /** Connects to Postgres in place of `databaseUrl`, such as to one in-process; called on every boot. */
      connectDatabase: () => PostgresConnection;
    };

/** What a process shares among the Families it serves. */
export type SharedConfig = {
  /** The `tessdata` volume of Tesseract models, bundled and downloaded. */
  tessdataDirectory: string;
  /** Where the image keeps the Tesseract models it ships, linked into the volume on start. */
  bundledTessdataDirectory: string | null;
  /** Replaces downloading from `tessdata_fast`, such as with canned models and their checksums. */
  tessdataCatalog?: TessdataCatalog;
  /** The Source Types, whose plugins run in containers of their own, by URL (ADR-0001). */
  pluginContainers?: PluginBinding[];
  /** Replaces the timeouts of the plugin contract, such as in a test of a plugin that does not answer. */
  pluginContainerOptions?: Omit<PluginContainerOptions, "ticketing">;
  /**
   * The key the tickets of plugin calls are signed with, shared with the egress proxies
   * (`EGRESS_TICKET_KEY`); without it, a random key that no proxy knows, so every ticket is refused.
   */
  egressTicketKey?: string | null;
  clock?: Clock;
  /** Replaces the OpenAI-compatible Extractor, such as with a scripted one. */
  extractor?: Extractor;
  /** Replaces the poppler and Tesseract command-line tools, such as with a fake. */
  textExtractor?: TextExtractor;
  /**
   * The key the Identity Provider signs its registration events with (`IDP_WEBHOOK_SECRET`,
   * ADR-0010); without it, no events are received.
   */
  idpWebhookSecret?: string | null;
  /** Replaces what a registration does, such as with a recording one. */
  registration?: Registration;
  /** The Identity Provider's management API (`IDP_MANAGEMENT_*`, ADR-0010); none if left out. */
  identityDirectory?: IdentityDirectorySettings | null;
  /** Replaces the adapter of the management API, such as with an in-memory one. */
  identityDirectoryClient?: IdentityDirectory;
  /** The LLM endpoint every Family extracts through (`LLM_*`); none if left out, and each Family saves its own. */
  suppliedLlmEndpoint?: LlmEndpoint | null;
};

/** Where the key of a Family's Source credentials comes from. */
export type FamilyKeyConfig =
  | {
      /** Where the master key is kept, outside Postgres; created on first start. */
      masterKeyFile: string;
    }
  | {
      /** The family key a Context supplies (ADR-0003), kept in memory only; never written anywhere. */
      familyKey: Buffer;
    };

/** What belongs to one Family: its database and what is kept outside it. */
export type FamilyConfig = DatabaseConfig & FamilyKeyConfig & {
  /** The Family id to write for a database that has none yet (`FAMILY_ID`); a random UUID if left out. */
  familyId?: FamilyId;
  /** Where files such as photos are kept, outside Postgres. */
  blobDirectory: string;
  /** The IANA time zone the Family lives in; by default the one of the process (`TZ`). */
  timeZone?: string;
  secretStore?: SecretStore;
  /** Replaces the BlobStore in the blob directory, such as with an in-memory one. */
  blobStore?: BlobStore;
  /** The one Identity Provider Admins may sign in through, from the environment (ADR-0007); none if left out. */
  identityProvider?: IdentityProviderSettings | null;
  /** Replaces the OIDC client that talks to the Identity Provider, such as with a scripted one. */
  identityProviderClient?: IdentityProviderClient;
  /** Replaces how long the turns of Sources' runs last and are waited for (ADR-0008), such as in a test that outlasts one. */
  sourceRunTurns?: Partial<TurnTimings>;
  /**
   * Leaves an OCR model in place when the Family removes its language, since other Families of the
   * process may read with it (supplied mode); the model is deleted otherwise, as in fixed mode.
   */
  keepOcrModels?: boolean;
};

/** An Instance of exactly one Family, as the environment configures it. */
export type ApplicationConfig = SharedConfig & FamilyConfig;

/** The wiring a process shares among its Families: plugin bindings, extractors, OCR models and the clock. */
export type SharedWiring = {
  clock: Clock;
  /** The bound Source Types and their descriptions; `forFamily` tickets their calls for one Family. */
  plugins: PluginContainers;
  /** The longest preparing a Source being added may take. */
  preparationMaxMs: number;
  extractor: Extractor;
  textExtractor: TextExtractor;
  ocrModels: TessdataDirectory;
  idpWebhookSecret: string | null;
  /** What replaces registration, as a test does; null for the one the Family's mode gives. */
  registration: Registration | null;
  /** The Identity Provider's management API; null without one, and then no registration. */
  directory: IdentityDirectory | null;
  /** The LLM endpoint the operator supplies for every Family; null for none. */
  suppliedLlmEndpoint: LlmEndpoint | null;
};

/** What preparing the Family did: the Family id it has. */
export type PreparedFamily = { familyId: string };

export type Application = {
  /** What names the Family outside its database, such as in the ticket of a plugin call. */
  familyId: string;
  /** The IANA time zone the Family lives in. */
  timeZone: string;
  /** Keeps slow plugin and LLM answers briefly, failures shorter. */
  cached: Cached;
  admins: AdminAccess;
  secrets: SecretStore;
  /** Removes the secrets nothing refers to any more, once; the worker does when it starts. */
  secretSweep: SecretSweep;
  /** Deletes messages' text and attachments after their retention, once; the worker does once an hour. */
  retention: Retention;
  recoveryKit: RecoveryKitAccess;
  familyMembers: FamilyMemberAccess;
  /** The Family Language and the OCR languages. */
  languages: LanguageAccess;
  agendas: AgendaAccess;
  /** Ticking Tasks done, from an Agenda or the Admin area. */
  tasks: TaskAccess;
  sourceTypes: SourceTypeAccess;
  /** What an Admin enables within a Source Type, such as Messengers. */
  catalogues: CatalogueAccess;
  sources: SourceAccess;
  /** Runs the Sources that are due, or one Source now. */
  polling: SourcePolling;
  /** Runs the due Sources, then Extraction, once; the worker does once a minute. */
  dueWork: DueWork;
  llmEndpoint: LlmEndpointAccess;
  /** Signing in through the Identity Provider, the only way Admins sign in (ADR-0009). */
  singleSignOn: SingleSignOn;
  /** Extracts Items from the raw messages that wait for it, as part of due work. */
  extraction: ExtractionAccess;
  messages: MessageAccess;
  /** The Identity Provider's registration events (ADR-0010); null without `IDP_WEBHOOK_SECRET`. */
  registrationEvents: RegistrationEvents | null;
  /** What a registration does, and whether it is open (ADR-0010). */
  registration: Registration;
  /** The Family's Admins in the Identity Provider, for the Admins page (ADR-0010). */
  familyAdmins: FamilyAdmins;
  close(): Promise<void>;
};

/** What storing a Source its plugin prepared may take, on top of the plugin's answer. */
const storingPreparedMs = 60_000;

/** The longest preparing a Source being added may take: its plugin's answer, then storing it. */
function preparationMaxMsOf(options: ApplicationConfig["pluginContainerOptions"]): number {
  return (options?.timeoutsMs?.sourceAdded ?? endpoints.sourceAdded.timeoutMs) + storingPreparedMs;
}

/** Wires what a process shares among its Families, once when it starts. */
export async function bootShared(config: SharedConfig): Promise<SharedWiring> {
  const ocrModels = new TessdataDirectory({
    directory: config.tessdataDirectory,
    bundledDirectory: config.bundledTessdataDirectory,
    catalog: config.tessdataCatalog ?? tessdataFastCatalog(),
  });
  await mkdir(config.tessdataDirectory, { recursive: true });
  await ocrModels.linkBundled();
  const plugins = await PluginContainers.connect(config.pluginContainers ?? [], {
    ...config.pluginContainerOptions,
    // No Family id: each Family's calls are ticketed for it alone, through `forFamily`.
    ticketing: { ticketKey: config.egressTicketKey ?? randomBytes(32).toString("base64url") },
  });
  return {
    clock: config.clock ?? new SystemClock(),
    plugins,
    preparationMaxMs: preparationMaxMsOf(config.pluginContainerOptions),
    extractor: config.extractor ?? new OpenAiCompatibleExtractor(),
    textExtractor: config.textExtractor ?? new CommandLineTextExtractor({ tessdataDirectory: config.tessdataDirectory }),
    ocrModels,
    suppliedLlmEndpoint: config.suppliedLlmEndpoint ?? null,
    ...registrationWiringOf(config),
  };
}

/** How a process receives the Identity Provider's registration events, the same for all its Families. */
function registrationWiringOf(config: SharedConfig): Pick<SharedWiring, "idpWebhookSecret" | "registration" | "directory"> {
  return {
    idpWebhookSecret: config.idpWebhookSecret ?? null,
    registration: config.registration ?? null,
    directory: config.identityDirectoryClient ?? (config.identityDirectory ? new LogtoIdentityDirectory(config.identityDirectory) : null),
  };
}

/** With a management API, sign-in accepts an invitee's invitation (ADR-0010); nothing without one. */
export function invitationAcceptanceOf(shared: Pick<SharedWiring, "clock" | "directory">): { acceptInvitation?: InvitationAcceptance } {
  return shared.directory ? { acceptInvitation: createInvitationAcceptance({ clock: shared.clock, directory: shared.directory }) } : {};
}

/**
 * How a Family is registered: in fixed mode with a management API, the first registration creates
 * it (ADR-0010). A supplied Family offers none: it exists once a Context opens it, and new Admins
 * join by invitation; the deployment's registration (see `openSuppliedRegistration`) creates Families
 * through the caller port, outside any Family.
 */
function registrationOf(shared: SharedWiring, families: PostgresFamilyRepository, mode: "fixed" | "supplied"): Registration {
  if (mode === "supplied") return noRegistration;
  if (shared.registration !== null) return shared.registration;
  if (shared.directory === null) return noRegistration;
  return createFamilyRegistration({ families, directory: shared.directory });
}

/**
 * A fixed Family's registration events, recorded in its database; none without the webhook secret.
 * None for a supplied Family either: a registration there belongs to no Family yet, so the caller
 * port receives it, recorded in the registration database (ADR-0010).
 */
function registrationEventsOf(shared: SharedWiring, postgres: PostgresConnection, registration: Registration, mode: "fixed" | "supplied"): RegistrationEvents | null {
  if (shared.idpWebhookSecret === null || mode === "supplied") return null;
  return createRegistrationEvents({
    clock: shared.clock,
    secret: shared.idpWebhookSecret,
    processedEvents: new PostgresProcessedEventRepository(postgres.db),
    registration,
  });
}

async function withDatabase<T>(postgres: PostgresConnection, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await postgres.close();
    throw error;
  }
}

/** Wires the use cases to their adapters, for an Instance of one Family. Shared by `api`, `worker` and the CLI. */
export async function bootApplication(config: ApplicationConfig): Promise<Application> {
  return bootFamily(await bootShared(config), config);
}

const connectionOf = (config: DatabaseConfig): PostgresConnection =>
  "connectDatabase" in config ? config.connectDatabase() : connectPostgres(config.databaseUrl);

/**
 * Wires one Family's use cases to its database, stores and cache, on the wiring the process shares,
 * after Preparing the Family.
 */
export async function bootFamily(shared: SharedWiring, config: FamilyConfig): Promise<Application> {
  const postgres = connectionOf(config);
  const { masterKey, familyId } = await withDatabase(postgres, async () => {
    // The Family id is read only once the Family is prepared: it never changes after.
    const { familyId } = await prepareOn(shared, postgres, config.familyId, ownBlobDirectory(config));
    return { masterKey: await familyKeyOf(postgres, config), familyId };
  });
  return wireFamily(shared, config, postgres, masterKey, familyId, "fixed");
}

/** A database that holds no prepared Family: empty, or with a schema other than this version's. */
export class FamilyNotPreparedError extends Error {
  constructor() {
    super("The database holds no Family prepared by this version");
    this.name = "FamilyNotPreparedError";
  }
}

/** A Context naming another organization than the one the Family's database holds (ADR-0010). */
export class OrganizationIdConflictError extends Error {
  constructor() {
    super("The database holds another organization of the Family than the Context names; nothing was changed.");
    this.name = "OrganizationIdConflictError";
  }
}

/**
 * Records the Family's organization a Context names while the database holds none, as registration
 * does in fixed mode; refuses one that differs from the organization recorded.
 */
async function recordSuppliedOrganizationId(postgres: PostgresConnection, organizationId: string): Promise<void> {
  const families = new PostgresFamilyRepository(postgres.db);
  if (await families.recordOrganizationId(organizationId)) return;
  if ((await families.organizationId()) !== organizationId) throw new OrganizationIdConflictError();
}

/**
 * Wires the Family `familyId` names on its database, as a core in supplied mode opens one from a
 * Context (ADR-0003). A database that holds no Family, or one an older release prepared, is refused
 * as not prepared, for the core to prepare it first; one a newer release migrated, one of the old
 * data model, or one that holds another Family id, is refused with the error that says so. Each is
 * refused before anything is written. On a prepared one it migrates nothing, writes no Family id
 * and moves no blobs; it only records the Source Types seen for the first time, as starting does,
 * and the Family's organization `organizationId` names while it has none; one that differs from the
 * organization recorded is refused before anything is written.
 */
export async function openPreparedFamily(shared: SharedWiring, config: FamilyConfig & { familyId: FamilyId; organizationId?: string }): Promise<Application> {
  const postgres = connectionOf(config);
  const masterKey = await withDatabase(postgres, async () => {
    await checkPreparedSchema(postgres);
    const stored = await storedFamilyId(postgres.db);
    if (stored === null) throw new FamilyNotPreparedError();
    if (stored !== config.familyId) throw new FamilyIdConflictError(stored, config.familyId);
    if (config.organizationId !== undefined) await recordSuppliedOrganizationId(postgres, config.organizationId);
    await startSourceTypes(shared, postgres, config.familyId);
    return familyKeyOf(postgres, config);
  });
  return wireFamily(shared, config, postgres, masterKey, config.familyId, "supplied");
}

/**
 * Refuses, without writing anything, a database whose schema is not this release's: one of the old
 * data model or migrated by a newer release with the error that says so, one an older release
 * prepared, or an empty one, as not prepared.
 */
export async function checkPreparedSchema(postgres: Pick<PostgresConnection, "db">): Promise<void> {
  await refuseOldMigrationHistory(postgres.db, migrationsFolder);
  await refuseNewerMigrationHistory(postgres.db, migrationsFolder);
  if (!(await isSchemaCurrent(postgres.db, migrationsFolder))) throw new FamilyNotPreparedError();
}

/**
 * Preparing the Family on its database, booted or not, even empty: brings the schema up to date,
 * writes a given Family id while there is none and refuses a different one, moves blobs of the old layout into the Family's folder, records the Source
 * Types seen for the first time as disabled and migrates the configuration of the Sources of
 * enabled ones. Running it again changes nothing.
 */
export async function prepareFamily(
  shared: SharedWiring,
  database: DatabaseConfig & BlobConfig,
  familyId?: FamilyId,
): Promise<PreparedFamily> {
  const postgres = connectionOf(database);
  try {
    return await prepareOn(shared, postgres, familyId, ownBlobDirectory(database));
  } finally {
    await postgres.close();
  }
}

/** Where a Family's blobs are kept, as far as Preparing the Family needs to know. */
type BlobConfig = Partial<Pick<FamilyConfig, "blobDirectory" | "blobStore">>;

/** The blob directory the Family's blobs are kept in as files, unless another BlobStore replaces it. */
const ownBlobDirectory = (config: BlobConfig): string | undefined =>
  config.blobStore === undefined ? config.blobDirectory : undefined;

async function prepareOn(
  shared: SharedWiring,
  postgres: PostgresConnection,
  familyId: FamilyId | undefined,
  blobDirectory: string | undefined,
): Promise<PreparedFamily & { familyId: FamilyId }> {
  await runMigrations(postgres, familyId === undefined ? {} : { familyId });
  const prepared = { familyId: await new PostgresFamilyRepository(postgres.db).familyId() };
  // Blobs of the layout before Family folders move into the Family's folder (docs/upgrading.md).
  if (blobDirectory !== undefined) await new FileBlobStore(blobDirectory, prepared.familyId).adoptTopLevelBlobs();
  await startSourceTypes(shared, postgres, prepared.familyId);
  return prepared;
}

/**
 * Records the Source Types and catalogue entries seen for the first time as disabled, and migrates
 * the configuration of the Sources of enabled ones; running it again changes nothing.
 */
async function startSourceTypes(shared: SharedWiring, postgres: PostgresConnection, familyId: FamilyId): Promise<void> {
  const registry = shared.plugins.forFamily(familyId);
  const sourceTypes = new PostgresSourceTypeRepository(postgres.db);
  await createSourceTypeAccess({ registry, sourceTypes, sources: new PostgresSourceRepository(postgres.db), clock: shared.clock }).start();
  await createCatalogueAccess({ cached: createCache(shared.clock), registry, sourceTypes, catalogues: new PostgresCatalogueRepository(postgres.db) }).start();
}

function wireFamily(
  shared: SharedWiring,
  config: FamilyConfig,
  postgres: PostgresConnection,
  masterKey: Buffer,
  familyId: FamilyId,
  mode: "fixed" | "supplied",
): Application {
  const { clock, extractor, textExtractor, ocrModels } = shared;
  const timeZone = config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const secrets = config.secretStore ?? new EnvelopeSecretStore(postgres.db, masterKey);
  const blobs = config.blobStore ?? new FileBlobStore(config.blobDirectory, familyId);
  const registry = shared.plugins.forFamily(familyId);
  const families = new PostgresFamilyRepository(postgres.db);

  const admins = createAdminAccess({
    clock,
    sessions: new PostgresAdminSessionRepository(postgres.db),
  });

  const recoveryKit = createRecoveryKitAccess({ clock, families, masterKey });

  const members = new PostgresFamilyMemberRepository(postgres.db);
  const familyMembers = createFamilyMemberAccess({ clock, members, blobs });
  const languages = createLanguageAccess({ families, ocrModels, keepModels: config.keepOcrModels });

  const items = new PostgresItemRepository(postgres.db);
  const activity = createActivityLog({ clock, activities: new PostgresActivityRepository(postgres.db) });
  const sourceTypeRepository = new PostgresSourceTypeRepository(postgres.db);
  const sourceRepository = new PostgresSourceRepository(postgres.db);
  const sourceHealth = createSourceHealth({
    clock,
    registry,
    sourceTypes: sourceTypeRepository,
    sources: sourceRepository,
  });
  const agendaRepository = new PostgresAgendaRepository(postgres.db);
  const agendas = createAgendaAccess({
    clock,
    timeZone,
    families,
    members,
    agendas: agendaRepository,
    items,
    registry,
    activity,
    sourceHealth,
  });
  const tasks = createTaskAccess({ clock, items, agendas: agendaRepository });

  const sourceTypes = createSourceTypeAccess({
    registry,
    sourceTypes: sourceTypeRepository,
    sources: sourceRepository,
    clock,
  });
  // Slow plugin and LLM answers, kept briefly for all use cases and pages of this Family alone.
  const cached = createCache(clock);
  const catalogueRepository = new PostgresCatalogueRepository(postgres.db);
  const catalogues = createCatalogueAccess({
    cached,
    registry,
    sourceTypes: sourceTypeRepository,
    catalogues: catalogueRepository,
  });
  const sources = createSourceAccess({
    clock,
    cached,
    timeZone,
    members,
    registry,
    sourceTypes: sourceTypeRepository,
    catalogues: catalogueRepository,
    sources: sourceRepository,
    addings: new PostgresSourceAddingRepository(postgres.db),
    preparationMaxMs: shared.preparationMaxMs,
    secrets,
    blobs,
  });
  const polling = createSourcePolling({
    clock,
    timeZone,
    registry,
    sourceTypes: sourceTypeRepository,
    catalogues: catalogueRepository,
    sources: sourceRepository,
    secrets,
    items,
    blobs,
    activity,
    turns: new PostgresSourceRunTurns(postgres.db),
    turnTimings: config.sourceRunTurns ?? {},
  });
  const endpoints = new PostgresLlmEndpointRepository(postgres.db);
  const llmEndpoint = createLlmEndpointAccess({
    clock,
    endpoints,
    secrets,
    extractor,
    supplied: shared.suppliedLlmEndpoint,
  });
  const singleSignOn = createSingleSignOn({
    settings: config.identityProvider ?? null,
    client: config.identityProviderClient ?? new OidcIdentityProviderClient(),
    admins,
    organizationId: () => families.organizationId(),
    ...invitationAcceptanceOf(shared),
  });
  const retention = createRetention({ clock, items, blobs });
  const secretSweep = createSecretSweep({
    clock,
    secrets,
    sources: sourceRepository,
    endpoints,
  });
  const extraction = createExtraction({
    clock,
    timeZone,
    families,
    endpoints,
    secrets,
    suppliedEndpoint: shared.suppliedLlmEndpoint,
    items,
    blobs,
    extractor,
    textExtractor,
    ocrModels,
    activity,
  });
  const messages = createMessageAccess({ items, blobs });
  const registration = registrationOf(shared, families, mode);
  const familyAdmins = createFamilyAdmins({ clock, families, directory: shared.directory, familyLanguage: () => languages.familyLanguage() });
  return {
    familyId,
    timeZone,
    cached,
    admins,
    secrets,
    secretSweep,
    retention,
    recoveryKit,
    familyMembers,
    languages,
    agendas,
    tasks,
    sourceTypes,
    catalogues,
    sources,
    polling,
    dueWork: createDueWork({ polling, extraction }),
    llmEndpoint,
    singleSignOn,
    extraction,
    messages,
    registrationEvents: registrationEventsOf(shared, postgres, registration, mode),
    registration,
    familyAdmins,
    close: () => postgres.close(),
  };
}

const familyKeyOf = (postgres: PostgresConnection, config: FamilyKeyConfig): Promise<Buffer> =>
  "familyKey" in config ? Promise.resolve(config.familyKey) : loadMasterKey(postgres, config.masterKeyFile);

/** Creates the master key on first start, but never a new one for secrets stored with a lost one. */
async function loadMasterKey(postgres: PostgresConnection, file: string): Promise<Buffer> {
  const existing = await readMasterKey(file);
  if (existing) return existing;
  if (await holdsSecrets(postgres.db)) {
    throw new Error(
      `The master key file ${file} is missing, but Postgres holds secrets stored with it. ` +
        "Put the file back; a new key could not read them.",
    );
  }
  return createMasterKey(file);
}

export type WorkerConfig = ApplicationConfig & {
  /** Replaces pg-boss on `databaseUrl`, such as with pg-boss on an in-process database. */
  workRunner?: WorkRunner & { start(): Promise<void>; stop(): Promise<void> };
  /** Where failures and refusals are written; the console by default. */
  log?: WorkLog;
};

/** The same Application, taking its work from pg-boss schedules in the Family's database. */
export async function bootWorker(config: WorkerConfig): Promise<Application> {
  const log = config.log ?? console;
  const schedule = config.workRunner ?? pgBossOn(config, log);
  const application = await bootApplication(config);
  await schedule.start();
  await startBackgroundWork(application, schedule, log);
  return {
    ...application,
    async close() {
      await schedule.stop();
      await application.close();
    },
  };
}

function pgBossOn(config: DatabaseConfig, log: WorkLog): PgBossWorkRunner {
  if (!("databaseUrl" in config)) throw new Error("The worker needs a databaseUrl for pg-boss, or a workRunner.");
  return new PgBossWorkRunner({ connectionString: config.databaseUrl }, log);
}
