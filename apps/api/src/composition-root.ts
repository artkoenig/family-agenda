import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  PostgresAdminRepository,
  PostgresAdminSessionRepository,
  PostgresFamilyMemberRepository,
  PostgresFamilyRepository,
  PostgresItemRepository,
  PostgresLlmEndpointRepository,
  PostgresSignInFailureLog,
  PostgresSourceRepository,
  PostgresSourceTypeRepository,
  PostgresViewRepository,
  readMasterKey,
  runMigrations,
  SystemClock,
  type PostgresConnection,
} from "@family-butler/adapters";
import {
  createAdminAccess,
  createExtraction,
  createFamilyMemberAccess,
  createLlmEndpointAccess,
  createMessageAccess,
  createRecoveryKitAccess,
  createSourceAccess,
  createSourcePolling,
  createSourceTypeAccess,
  createViewAccess,
  signInLimits,
  type AdminAccess,
  type BlobStore,
  type ExtractionAccess,
  type Extractor,
  type FamilyMemberAccess,
  type Clock,
  type JobQueue,
  type LlmEndpointAccess,
  type MessageAccess,
  type RecoveryKitAccess,
  type SecretStore,
  type SourceAccess,
  type SourcePolling,
  type SourceTypeAccess,
  type TextExtractor,
  type ViewAccess,
} from "@family-butler/application";
import { SourceRegistry } from "./source-registry";

const defaultWorkspacePackages = fileURLToPath(new URL("../../../packages", import.meta.url));

const packageVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export type ApplicationConfig = {
  databaseUrl: string;
  /** Where the master key is kept, outside Postgres; created on first start. */
  masterKeyFile: string;
  /** Where files such as photos are kept, outside Postgres. */
  blobDirectory: string;
  /** The `plugins/` volume, for Source plugins an operator adds to a stock image. */
  pluginDirectory: string;
  /** Where the Source plugins shipped with Family Butler are; by default the workspace's packages. */
  workspacePackages?: string;
  /** The version of Family Butler, which new Source Types are recorded with. */
  applicationVersion?: string;
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
};

export type Application = {
  /** The IANA time zone the Family lives in. */
  timeZone: string;
  admins: AdminAccess;
  secrets: SecretStore;
  recoveryKit: RecoveryKitAccess;
  familyMembers: FamilyMemberAccess;
  views: ViewAccess;
  sourceTypes: SourceTypeAccess;
  sources: SourceAccess;
  /** Runs the Sources that are due; the worker does on each tick. */
  polling: SourcePolling;
  llmEndpoint: LlmEndpointAccess;
  /** Extracts Items from the raw messages that wait for it; the worker does on each tick. */
  extraction: ExtractionAccess;
  messages: MessageAccess;
  close(): Promise<void>;
};

/** Wires the use cases to their adapters. Shared by `api`, `worker` and the CLI. */
export async function bootApplication(config: ApplicationConfig): Promise<Application> {
  const postgres = connectPostgres(config.databaseUrl);
  let masterKey: Buffer;
  try {
    await runMigrations(postgres);
    masterKey = await loadMasterKey(postgres, config.masterKeyFile);
  } catch (error) {
    await postgres.close();
    throw error;
  }

  const clock = config.clock ?? new SystemClock();
  const families = new PostgresFamilyRepository(postgres.db);

  const admins = createAdminAccess({
    clock,
    passwordHasher: new Argon2idPasswordHasher(),
    families,
    admins: new PostgresAdminRepository(postgres.db),
    sessions: new PostgresAdminSessionRepository(postgres.db),
    signInFailures: new PostgresSignInFailureLog(postgres.db, signInLimits.windowMs),
  });

  const secrets = config.secretStore ?? new EnvelopeSecretStore(postgres.db, masterKey);

  const recoveryKit = createRecoveryKitAccess({ clock, families, masterKey });

  const blobs = config.blobStore ?? new FileBlobStore(config.blobDirectory);
  const members = new PostgresFamilyMemberRepository(postgres.db);
  const familyMembers = createFamilyMemberAccess({ clock, families, members, blobs });

  const timeZone = config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const items = new PostgresItemRepository(postgres.db);
  const views = createViewAccess({
    clock,
    timeZone,
    families,
    members,
    views: new PostgresViewRepository(postgres.db),
    items,
  });

  const registry = await SourceRegistry.discover([
    config.workspacePackages ?? defaultWorkspacePackages,
    config.pluginDirectory,
  ]);
  const sourceTypeRepository = new PostgresSourceTypeRepository(postgres.db);
  const sourceRepository = new PostgresSourceRepository(postgres.db);
  const sourceTypes = createSourceTypeAccess({
    clock,
    applicationVersion: config.applicationVersion ?? packageVersion,
    registry,
    sourceTypes: sourceTypeRepository,
    sources: sourceRepository,
  });
  const sources = createSourceAccess({
    clock,
    families,
    registry,
    sourceTypes: sourceTypeRepository,
    sources: sourceRepository,
    secrets,
  });
  const polling = createSourcePolling({
    clock,
    timeZone,
    registry,
    sourceTypes: sourceTypeRepository,
    sources: sourceRepository,
    secrets,
    items,
    blobs,
  });
  const endpoints = new PostgresLlmEndpointRepository(postgres.db);
  const llmEndpoint = createLlmEndpointAccess({ clock, families, endpoints, secrets });
  const extraction = createExtraction({
    clock,
    timeZone,
    families,
    endpoints,
    secrets,
    items,
    blobs,
    extractor: config.extractor ?? new OpenAiCompatibleExtractor(),
    textExtractor: config.textExtractor ?? new CommandLineTextExtractor(),
  });
  const messages = createMessageAccess({ items, blobs });
  try {
    await sourceTypes.start();
  } catch (error) {
    await postgres.close();
    throw error;
  }

  return {
    timeZone,
    admins,
    secrets,
    recoveryKit,
    familyMembers,
    views,
    sourceTypes,
    sources,
    polling,
    llmEndpoint,
    extraction,
    messages,
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
export async function bootWorker(config: ApplicationConfig): Promise<Worker> {
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
