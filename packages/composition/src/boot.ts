import {
  runMigrations,
  masterKeyLength,
  PostgresActivityRepository,
  PostgresAdminRepository,
  PostgresAdminSessionRepository,
  PostgresAgendaRepository,
  PostgresCatalogueRepository,
  PostgresFamilyMemberRepository,
  PostgresFamilyRepository,
  PostgresIdentityProviderRepository,
  PostgresItemRepository,
  PostgresLlmEndpointRepository,
  PostgresSignInFailureLog,
  PostgresSourceRepository,
  PostgresSourceTypeRepository,
  type PostgresConnection,
} from "@family-agenda/adapters";
import {
  createActivityLog,
  createAdminAccess,
  createAgendaAccess,
  createCatalogueAccess,
  createCleanup,
  createDueWork,
  createExtraction,
  createFamilyMemberAccess,
  createLanguageAccess,
  createLlmEndpointAccess,
  createMessageAccess,
  createRecoveryKitAccess,
  createRetention,
  createSecretSweep,
  createServiceSupervision,
  createSingleSignOn,
  createSourceAccess,
  createSourceHealth,
  createSourcePolling,
  createSourceTypeAccess,
  createTaskAccess,
  signInLimits,
} from "@family-agenda/application";
import type { Adapters } from "./adapters";
import type { Application } from "./application";
import { assertTimeZone, type ApplicationConfig } from "./config";
import { SourceRegistry } from "./source-registry";

async function withDatabase<T>(postgres: PostgresConnection, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await postgres.close();
    throw error;
  }
}

/** The same Application, for the process that runs the background work. */
export type Worker = Application;

/**
 * Wires the use cases to their adapters. Shared by `api`, `worker` and the CLI. It takes over the
 * connection in `adapters`: it closes it should booting fail, and `close()` closes it.
 */
export async function bootApplication(config: ApplicationConfig, adapters: Adapters): Promise<Application> {
  const { postgres, clock, masterKey, secrets, blobs, extractor, textExtractor, ocrModels } = adapters;
  const { timeZone } = config;
  await withDatabase(postgres, async () => {
    assertTimeZone(timeZone);
    if (masterKey.length !== masterKeyLength) {
      throw new Error(`The master key must be ${masterKeyLength} bytes, not ${masterKey.length}.`);
    }
    await runMigrations(postgres);
  });

  const families = new PostgresFamilyRepository(postgres.db);

  const admins = createAdminAccess({
    clock,
    passwordHasher: adapters.passwordHasher,
    families,
    admins: new PostgresAdminRepository(postgres.db),
    sessions: new PostgresAdminSessionRepository(postgres.db),
    signInFailures: new PostgresSignInFailureLog(postgres.db, signInLimits.windowMs),
  });

  const recoveryKit = createRecoveryKitAccess({ clock, families, masterKey });

  const members = new PostgresFamilyMemberRepository(postgres.db);
  const familyMembers = createFamilyMemberAccess({ clock, members, blobs });

  const languages = createLanguageAccess({ families, ocrModels });

  const items = new PostgresItemRepository(postgres.db);
  const activity = createActivityLog({ clock, activities: new PostgresActivityRepository(postgres.db) });
  const registry = await SourceRegistry.discover(adapters.pluginDirectories, { pluginHost: adapters.pluginHost ?? null });
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
  const services = createServiceSupervision({ registry, sourceTypes: sourceTypeRepository, catalogues: catalogueRepository });
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
    client: adapters.identityProviderClient,
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
    sources: sourceRepository,
    blobs,
    extractor,
    textExtractor,
    ocrModels,
    activity,
  });
  const messages = createMessageAccess({ items, blobs });
  const dueWork = createDueWork({ clock, polling, extraction });
  const cleanup = createCleanup({ retention, secretSweep });
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
    services,
    llmEndpoint,
    singleSignOn,
    extraction,
    dueWork,
    cleanup,
    messages,
    close: () => postgres.close(),
  };
}


/** The same Application as `bootApplication`, for the process that runs the background work. */
export function bootWorker(config: ApplicationConfig, adapters: Adapters): Promise<Worker> {
  return bootApplication(config, adapters);
}
