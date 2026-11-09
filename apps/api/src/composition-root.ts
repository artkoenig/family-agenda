import { mkdir } from "node:fs/promises";
import {
  Argon2idPasswordHasher,
  CommandLineTextExtractor,
  connectPostgres,
  createMasterKey,
  EnvelopeSecretStore,
  FileBlobStore,
  holdsSecrets,
  OpenAiCompatibleExtractor,
  PgBossJobQueue,
  PostgresActivityRepository,
  PostgresAdminRepository,
  PostgresAdminSessionRepository,
  PostgresCatalogueRepository,
  PostgresFamilyMemberRepository,
  PostgresFamilyRepository,
  PostgresItemRepository,
  PostgresIdentityProviderRepository,
  PostgresLlmEndpointRepository,
  OidcIdentityProviderClient,
  PostgresSignInFailureLog,
  PostgresSourceRepository,
  PostgresSourceTypeRepository,
  PostgresAgendaRepository,
  readMasterKey,
  runMigrations,
  SystemClock,
  TessdataDirectory,
  tessdataFastCatalog,
  type PostgresConnection,
  type TessdataCatalog,
} from "@family-agenda/adapters";
import {
  createActivityLog,
  createAdminAccess,
  createCatalogueAccess,
  createExtraction,
  createEgressHosts,
  createFamilyMemberAccess,
  createLanguageAccess,
  createLlmEndpointAccess,
  createSingleSignOn,
  createMessageAccess,
  createRecoveryKitAccess,
  createRetention,
  createSecretSweep,
  createSourceAccess,
  createSourceHealth,
  createSourcePolling,
  createSourceTypeAccess,
  createTaskAccess,
  createAgendaAccess,
  signInLimits,
  type AdminAccess,
  type CatalogueAccess,
  type EgressHosts,
  type BlobStore,
  type ExtractionAccess,
  type Extractor,
  type FamilyMemberAccess,
  type Clock,
  type LanguageAccess,
  type JobQueue,
  type IdentityProviderClient,
  type LlmEndpointAccess,
  type SingleSignOn,
  type MessageAccess,
  type RecoveryKitAccess,
  type SecretStore,
  type Retention,
  type SecretSweep,
  type SourceAccess,
  type SourcePolling,
  type SourceTypeAccess,
  type TextExtractor,
  type TaskAccess,
  type AgendaAccess,
} from "@family-agenda/application";
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

export type ApplicationConfig = DatabaseConfig & {
  /** Where the master key is kept, outside Postgres; created on first start. */
  masterKeyFile: string;
  /** Where files such as photos are kept, outside Postgres. */
  blobDirectory: string;
  /** The `tessdata` volume of Tesseract models, bundled and downloaded (ADR-0012). */
  tessdataDirectory: string;
  /** Where the image keeps the Tesseract models it ships, linked into the volume on start. */
  bundledTessdataDirectory: string | null;
  /** Replaces downloading from `tessdata_fast`, such as with canned models and their checksums. */
  tessdataCatalog?: TessdataCatalog;
  /** The Source Types, whose plugins run in containers of their own, by URL (ADR-0001). */
  pluginContainers?: PluginBinding[];
  /** Replaces the timeouts of the plugin contract, such as in a test of a plugin that does not answer. */
  pluginContainerOptions?: PluginContainerOptions;
  /** The IANA time zone the Family lives in; by default the one of the process (`TZ`). */
  timeZone?: string;
  clock?: Clock;
  secretStore?: SecretStore;
  /** Replaces the BlobStore in the blob directory, such as with an in-memory one. */
  blobStore?: BlobStore;
  /** Replaces the OpenAI-compatible Extractor, such as with a scripted one. */
  extractor?: Extractor;
  /** Replaces the poppler and Tesseract command-line tools, such as with a fake. */
  textExtractor?: TextExtractor;
  /** Replaces the OIDC client that talks to the Identity Provider, such as with a scripted one. */
  identityProviderClient?: IdentityProviderClient;
};

export type Application = {
  /** The IANA time zone the Family lives in. */
  timeZone: string;
  admins: AdminAccess;
  secrets: SecretStore;
  /** Removes the secrets nothing refers to any more; the worker does when it starts. */
  secretSweep: SecretSweep;
  /** Deletes messages' text and attachments after their retention; the worker does it in the background. */
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
  /** Which Family Members the Items of a Source's Origins concern. */
  /** Runs the Sources that are due; the worker does on each tick. */
  polling: SourcePolling;
  llmEndpoint: LlmEndpointAccess;
  /** Signing in through the Identity Provider, alongside the password. */
  singleSignOn: SingleSignOn;
  /** Extracts Items from the raw messages that wait for it; the worker does on each tick. */
  extraction: ExtractionAccess;
  messages: MessageAccess;
  /** The hosts in host fields of a Source Type's Sources, which its plugin's egress proxy allows. */
  egressHosts: EgressHosts;
  close(): Promise<void>;
};

function resolveDefaults(config: ApplicationConfig): {
  clock: Clock;
  timeZone: string;
  extractor: Extractor;
  textExtractor: TextExtractor;
} {
  return {
    clock: config.clock ?? new SystemClock(),
    timeZone: config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    extractor: config.extractor ?? new OpenAiCompatibleExtractor(),
    textExtractor: config.textExtractor ?? new CommandLineTextExtractor({ tessdataDirectory: config.tessdataDirectory }),
  };
}

function resolveStores(
  config: ApplicationConfig,
  postgres: PostgresConnection,
  masterKey: Buffer,
): { secrets: SecretStore; blobs: BlobStore; tessdataCatalog: TessdataCatalog } {
  return {
    secrets: config.secretStore ?? new EnvelopeSecretStore(postgres.db, masterKey),
    blobs: config.blobStore ?? new FileBlobStore(config.blobDirectory),
    tessdataCatalog: config.tessdataCatalog ?? tessdataFastCatalog(),
  };
}

async function withDatabase<T>(postgres: PostgresConnection, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await postgres.close();
    throw error;
  }
}

/** Wires the use cases to their adapters. Shared by `api`, `worker` and the CLI. */
export async function bootApplication(config: ApplicationConfig): Promise<Application> {
  const postgres = "connectDatabase" in config ? config.connectDatabase() : connectPostgres(config.databaseUrl);
  const masterKey = await withDatabase(postgres, async () => {
    await runMigrations(postgres);
    return await loadMasterKey(postgres, config.masterKeyFile);
  });

  const { clock, timeZone, extractor, textExtractor } = resolveDefaults(config);
  const { secrets, blobs, tessdataCatalog } = resolveStores(config, postgres, masterKey);
  const families = new PostgresFamilyRepository(postgres.db);

  const admins = createAdminAccess({
    clock,
    passwordHasher: new Argon2idPasswordHasher(),
    families,
    admins: new PostgresAdminRepository(postgres.db),
    sessions: new PostgresAdminSessionRepository(postgres.db),
    signInFailures: new PostgresSignInFailureLog(postgres.db, signInLimits.windowMs),
  });

  const recoveryKit = createRecoveryKitAccess({ clock, families, masterKey });

  const members = new PostgresFamilyMemberRepository(postgres.db);
  const familyMembers = createFamilyMemberAccess({ clock, members, blobs });

  const ocrModels = new TessdataDirectory({
    directory: config.tessdataDirectory,
    bundledDirectory: config.bundledTessdataDirectory,
    catalog: tessdataCatalog,
  });
  await withDatabase(postgres, async () => {
    await mkdir(config.tessdataDirectory, { recursive: true });
    await ocrModels.linkBundled();
  });
  const languages = createLanguageAccess({ families, ocrModels });

  const items = new PostgresItemRepository(postgres.db);
  const activity = createActivityLog({ clock, activities: new PostgresActivityRepository(postgres.db) });
  const registry = await PluginContainers.connect(config.pluginContainers ?? [], config.pluginContainerOptions);
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
  const catalogueRepository = new PostgresCatalogueRepository(postgres.db);
  const catalogues = createCatalogueAccess({
    registry,
    sourceTypes: sourceTypeRepository,
    catalogues: catalogueRepository,
  });
  const sources = createSourceAccess({
    clock,
    timeZone,
    members,
    registry,
    sourceTypes: sourceTypeRepository,
    catalogues: catalogueRepository,
    sources: sourceRepository,
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
  });
  const endpoints = new PostgresLlmEndpointRepository(postgres.db);
  const llmEndpoint = createLlmEndpointAccess({
    clock,
    endpoints,
    secrets,
    extractor,
  });
  const identityProvider = new PostgresIdentityProviderRepository(postgres.db);
  const singleSignOn = createSingleSignOn({
    clock,
    provider: identityProvider,
    secrets,
    client: config.identityProviderClient ?? new OidcIdentityProviderClient(),
    admins,
  });
  const retention = createRetention({ clock, items, blobs });
  const secretSweep = createSecretSweep({
    clock,
    secrets,
    sources: sourceRepository,
    endpoints,
    identityProvider,
  });
  const extraction = createExtraction({
    clock,
    timeZone,
    families,
    endpoints,
    secrets,
    items,
    blobs,
    extractor,
    textExtractor,
    ocrModels,
    activity,
  });
  const messages = createMessageAccess({ items, blobs });
  const egressHosts = createEgressHosts({ registry, sources: sourceRepository });
  await withDatabase(postgres, async () => {
    await sourceTypes.start();
    await catalogues.start();
  });

  return {
    timeZone,
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
    llmEndpoint,
    singleSignOn,
    extraction,
    messages,
    egressHosts,
    close: () => postgres.close(),
  };
}

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

export type Worker = Application & { jobs: JobQueue };

/** The same Application, plus the job queue whose jobs the worker runs. */
export async function bootWorker(config: ApplicationConfig & { databaseUrl: string }): Promise<Worker> {
  const application = await bootApplication(config);
  const jobs = new PgBossJobQueue(config.databaseUrl);
  await jobs.start();
  return {
    ...application,
    jobs,
    async close() {
      await jobs.stop();
      await application.close();
    },
  };
}
