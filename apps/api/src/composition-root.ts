import {
  Argon2idPasswordHasher,
  connectPostgres,
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
  signInLimits,
  type AdminAccess,
  type Clock,
  type JobQueue,
} from "@family-butler/application";

export type ApplicationConfig = {
  databaseUrl: string;
  clock?: Clock;
};

export type Application = {
  admins: AdminAccess;
  close(): Promise<void>;
};

/** Wires the use cases to their adapters. Shared by `api`, `worker` and the CLI. */
export async function bootApplication(config: ApplicationConfig): Promise<Application> {
  const postgres = connectPostgres(config.databaseUrl);
  await runMigrations(postgres);

  const admins = createAdminAccess({
    clock: config.clock ?? new SystemClock(),
    passwordHasher: new Argon2idPasswordHasher(),
    families: new PostgresFamilyRepository(postgres.db),
    admins: new PostgresAdminRepository(postgres.db),
    sessions: new PostgresAdminSessionRepository(postgres.db),
    signInFailures: new PostgresSignInFailureLog(postgres.db, signInLimits.windowMs),
  });

  return { admins, close: () => postgres.close() };
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
