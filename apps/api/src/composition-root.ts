import {
  Argon2idPasswordHasher,
  connectPostgres,
  createMasterKey,
  EnvelopeSecretStore,
  FileBlobStore,
  holdsSecrets,
  PgBossJobQueue,
  PostgresAdminRepository,
  PostgresAdminSessionRepository,
  PostgresFamilyMemberRepository,
  PostgresFamilyRepository,
  PostgresSignInFailureLog,
  readMasterKey,
  runMigrations,
  SystemClock,
  type PostgresConnection,
} from "@family-butler/adapters";
import {
  createAdminAccess,
  createFamilyMemberAccess,
  createRecoveryKitAccess,
  signInLimits,
  type AdminAccess,
  type BlobStore,
  type FamilyMemberAccess,
  type Clock,
  type JobQueue,
  type RecoveryKitAccess,
  type SecretStore,
} from "@family-butler/application";

export type ApplicationConfig = {
  databaseUrl: string;
  /** Where the master key is kept, outside Postgres; created on first start. */
  masterKeyFile: string;
  /** Where files such as photos are kept, outside Postgres. */
  blobDirectory: string;
  clock?: Clock;
  secretStore?: SecretStore;
  blobStore?: BlobStore;
};

export type Application = {
  admins: AdminAccess;
  secrets: SecretStore;
  recoveryKit: RecoveryKitAccess;
  familyMembers: FamilyMemberAccess;
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

  const familyMembers = createFamilyMemberAccess({
    clock,
    families,
    members: new PostgresFamilyMemberRepository(postgres.db),
    blobs: config.blobStore ?? new FileBlobStore(config.blobDirectory),
  });

  return { admins, secrets, recoveryKit, familyMembers, close: () => postgres.close() };
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
