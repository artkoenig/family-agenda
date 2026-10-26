import {
  Argon2idPasswordHasher,
  connectPostgres,
  EnvelopeSecretStore,
  loadOrCreateMasterKey,
  PgBossJobQueue,
  PostgresAdminRepository,
  PostgresAdminSessionRepository,
  PostgresFamilyRepository,
  PostgresSignInFailureLog,
  runMigrations,
  SystemClock,
} from "@family-butler/adapters";
import {
  createAdminAccess,
  createRecoveryKitAccess,
  signInLimits,
  type AdminAccess,
  type Clock,
  type JobQueue,
  type RecoveryKitAccess,
  type SecretStore,
} from "@family-butler/application";

export type ApplicationConfig = {
  databaseUrl: string;
  /** Where the master key is kept, outside Postgres; created on first start. */
  masterKeyFile: string;
  clock?: Clock;
  secretStore?: SecretStore;
};

export type Application = {
  admins: AdminAccess;
  secrets: SecretStore;
  recoveryKit: RecoveryKitAccess;
  close(): Promise<void>;
};

/** Wires the use cases to their adapters. Shared by `api`, `worker` and the CLI. */
export async function bootApplication(config: ApplicationConfig): Promise<Application> {
  const postgres = connectPostgres(config.databaseUrl);
  await runMigrations(postgres);
  const masterKey = await loadOrCreateMasterKey(config.masterKeyFile);

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

  return { admins, secrets, recoveryKit, close: () => postgres.close() };
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
