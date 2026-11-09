import type { Companion, Plugin, PluginsFile } from "./schema";

type Service = Record<string, unknown>;
export type Compose = {
  services: Record<string, Service>;
  networks: Record<string, { internal: true }>;
  volumes: Record<string, Record<string, never>>;
};

const serviceOf = (plugin: Plugin) => `plugin-${plugin.id}`;
const companionServiceOf = (plugin: Plugin, companion: Companion) => `plugin-${plugin.id}-${companion.name}`;
const databaseNetworkOf = (plugin: Plugin) => `plugin-${plugin.id}-database`;
/** Role and database of a companion with `database: true`, such as `plugin_matrix_synapse`. */
const databaseNameOf = (plugin: Plugin, companion: Companion) => `plugin_${plugin.id}_${companion.name}`.replaceAll("-", "_");
/** The `.env` variable holding that database's password. */
const passwordVariableOf = (plugin: Plugin, companion: Companion) => `${databaseNameOf(plugin, companion).toUpperCase()}_DATABASE_PASSWORD`;
const databaseCompanionsOf = (plugin: Plugin) => plugin.companions.filter((companion) => companion.database);

/** Every `.env` variable the generated file needs: a database password each. */
export function passwordVariablesOf(file: PluginsFile): string[] {
  return file.plugins.flatMap((plugin) => databaseCompanionsOf(plugin).map((companion) => passwordVariableOf(plugin, companion)));
}

/** `compose.plugins.yaml`: the plugin containers, and what api, worker and postgres need to reach them. */
export function composeOf(file: PluginsFile): Compose {
  const compose: Compose = { services: {}, networks: {}, volumes: {} };
  for (const plugin of file.plugins) addPlugin(compose, plugin);
  const core = coreServiceOf(file);
  compose.services.api = core;
  compose.services.worker = core;
  const databaseNetworks = file.plugins.filter((plugin) => databaseCompanionsOf(plugin).length > 0).map(databaseNetworkOf);
  if (databaseNetworks.length > 0) compose.services.postgres = { networks: ["default", ...databaseNetworks] };
  return compose;
}

function addPlugin(compose: Compose, plugin: Plugin): void {
  compose.networks[serviceOf(plugin)] = { internal: true };
  compose.services[serviceOf(plugin)] = {
    image: plugin.image,
    restart: "unless-stopped",
    networks: [serviceOf(plugin)],
    mem_limit: plugin.limits.memory,
    cpus: plugin.limits.cpus,
  };
  for (const companion of plugin.companions) addCompanion(compose, plugin, companion);
}

function addCompanion(compose: Compose, plugin: Plugin, companion: Companion): void {
  const service: Service = { image: companion.image, restart: "unless-stopped", networks: [serviceOf(plugin)] };
  const environment: Record<string, string> = { ...companion.env };
  const volumes = Object.entries(companion.volumes).map(([name, path]) => {
    compose.volumes[`${serviceOf(plugin)}-${name}`] = {};
    return `${serviceOf(plugin)}-${name}:${path}`;
  });
  if (volumes.length > 0) service.volumes = volumes;
  if (companion.command !== undefined) service.command = companion.command;
  if (companion.healthcheck !== undefined) service.healthcheck = companion.healthcheck;
  if (companion.database) addDatabase(compose, plugin, companion, service, environment);
  if (Object.keys(environment).length > 0) service.environment = environment;
  compose.services[companionServiceOf(plugin, companion)] = service;
}

function addDatabase(compose: Compose, plugin: Plugin, companion: Companion, service: Service, environment: Record<string, string>): void {
  const database = databaseNameOf(plugin, companion);
  const initService = `${companionServiceOf(plugin, companion)}-database`;
  compose.networks[databaseNetworkOf(plugin)] = { internal: true };
  service.networks = [serviceOf(plugin), databaseNetworkOf(plugin)];
  environment.DATABASE_URL = `postgres://${database}:\${${passwordVariableOf(plugin, companion)}}@postgres:5432/${database}`;
  service.depends_on = { [initService]: { condition: "service_completed_successfully" } };
  compose.services[initService] = databaseInitOf(plugin, companion);
}

const databaseInitSql = [
  String.raw`SELECT format('CREATE ROLE %I LOGIN', :'name') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'name')\gexec`,
  String.raw`SELECT format('ALTER ROLE %I PASSWORD %L', :'name', :'password')\gexec`,
  String.raw`SELECT format('CREATE DATABASE %I OWNER %I', :'name', :'name') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'name')\gexec`,
].join("\n");

/**
 * Creates the companion's role and database on the Instance's Postgres, or sets the role's password
 * again. It runs before the companion on every start, so a plugin added later gets its database too.
 */
function databaseInitOf(plugin: Plugin, companion: Companion): Service {
  return {
    image: "postgres:17",
    restart: "no",
    networks: ["default"],
    environment: {
      PGPASSWORD: "${POSTGRES_PASSWORD:-family_agenda}",
      DATABASE_NAME: databaseNameOf(plugin, companion),
      DATABASE_PASSWORD: `\${${passwordVariableOf(plugin, companion)}}`,
      INIT_SQL: databaseInitSql,
    },
    command: [
      "sh",
      "-c",
      'printf "%s\\n" "$$INIT_SQL" | psql -h postgres -U family_agenda -d family_agenda -v ON_ERROR_STOP=1 -v name="$$DATABASE_NAME" -v password="$$DATABASE_PASSWORD"',
    ],
    depends_on: { postgres: { condition: "service_healthy" } },
  };
}

function coreServiceOf(file: PluginsFile): Service {
  return {
    environment: {
      PLUGIN_URLS: file.plugins.map((plugin) => `${plugin.id}=http://${serviceOf(plugin)}:8080`).join(","),
      PLUGIN_EGRESS: egressOf(file),
    },
    networks: ["default", ...file.plugins.map(serviceOf)],
  };
}

/**
 * The egress hosts per container, such as `plugin-demo=api.example.com:443;*.example.org:443`,
 * containers separated by commas, for the egress proxies to allow (ADR-0001).
 */
function egressOf(file: PluginsFile): string {
  const entries = file.plugins.flatMap((plugin) => [
    { service: serviceOf(plugin), hosts: plugin.egress },
    ...plugin.companions.map((companion) => ({ service: companionServiceOf(plugin, companion), hosts: companion.egress })),
  ]);
  return entries
    .filter((entry) => entry.hosts.length > 0)
    .map((entry) => `${entry.service}=${entry.hosts.join(";")}`)
    .join(",");
}
