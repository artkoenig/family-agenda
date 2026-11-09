import { pluginServiceOf, proxyOf } from "../egress/wiring";
import { allProxiedContainersOf, egressProxyOf, egressTokensOf, proxiedContainersOf, tokenVariablesOf } from "./egress-proxies";

export { proxyImageOf } from "./egress-proxies";
import type { Companion, Plugin, PluginsFile } from "./schema";

type Service = Record<string, unknown>;
export type Compose = {
  services: Record<string, Service>;
  networks: Record<string, { internal: true }>;
  volumes: Record<string, Record<string, never>>;
};

const serviceOf = (plugin: Plugin) => pluginServiceOf(plugin.id);
const databaseNetworkOf = (plugin: Plugin) => `plugin-${plugin.id}-database`;
const volumeOf = (plugin: Plugin, volume: string) => `${serviceOf(plugin)}-${volume}`;
/** The names derived for one companion. */
type CompanionNames = {
  service: string;
  /** Role and database on the Instance's Postgres, such as `plugin_matrix_synapse`. */
  database: string;
  /** The one-shot service creating that database. */
  databaseService: string;
  /** The `.env` variable holding that database's password. */
  passwordVariable: string;
};

function namesOf(plugin: Plugin, companion: Companion): CompanionNames {
  const service = `${serviceOf(plugin)}-${companion.name}`;
  const database = service.replaceAll("-", "_");
  return { service, database, databaseService: `${service}-database`, passwordVariable: `${database.toUpperCase()}_DATABASE_PASSWORD` };
}

const databaseCompanionsOf = (plugin: Plugin) => plugin.companions.filter((companion) => companion.database);

/** Every `.env` secret the generated file needs: a password per database, a token per egress proxy. */
export function passwordVariablesOf(file: PluginsFile): string[] {
  return [
    ...file.plugins.flatMap((plugin) => databaseCompanionsOf(plugin).map((companion) => namesOf(plugin, companion).passwordVariable)),
    ...tokenVariablesOf(file),
  ];
}

type Kind = "service" | "network" | "volume" | "database";

/**
 * Each generated name that two declarations would take; empty if none. The core's own names never
 * start with `plugin-` or `plugin_`, so plugins cannot take them.
 */
export function nameCollisionsOf(file: PluginsFile): string[] {
  const taken = new Map<string, string>();
  const collisions: string[] = [];
  const take = (kind: Kind, name: string, by: string) => {
    const key = `${kind} ${name}`;
    const earlier = taken.get(key);
    if (earlier === undefined) taken.set(key, by);
    else collisions.push(`plugins.yml: ${by} and ${earlier} both make the ${kind} ${name}; rename one`);
  };
  for (const plugin of file.plugins) takePlugin(plugin, take);
  return collisions;
}

function takePlugin(plugin: Plugin, take: (kind: Kind, name: string, by: string) => void): void {
  const by = `plugin ${plugin.id}`;
  take("service", serviceOf(plugin), by);
  take("network", serviceOf(plugin), by);
  for (const { service } of proxiedContainersOf(plugin)) {
    take("service", proxyOf(service), by);
    take("network", proxyOf(service), by);
  }
  if (databaseCompanionsOf(plugin).length > 0) take("network", databaseNetworkOf(plugin), by);
  const volumes = new Set([plugin, ...plugin.companions].flatMap((container) => Object.keys(container.volumes)));
  for (const volume of volumes) take("volume", volumeOf(plugin, volume), by);
  for (const companion of plugin.companions) {
    const names = namesOf(plugin, companion);
    const companionBy = `companion ${companion.name} of plugin ${plugin.id}`;
    take("service", names.service, companionBy);
    if (!companion.database) continue;
    take("service", names.databaseService, companionBy);
    take("database", names.database, companionBy);
  }
}

/** `compose.plugins.yaml`: the plugin containers, and what api, worker and postgres need to reach them. */
export function composeOf(file: PluginsFile, proxyImage: string): Compose {
  const compose: Compose = { services: {}, networks: {}, volumes: {} };
  for (const plugin of file.plugins) addPlugin(compose, plugin);
  for (const container of allProxiedContainersOf(file)) addProxy(compose, egressProxyOf(container, proxyImage), container.service);
  const core = coreServiceOf(file);
  compose.services.api = core;
  compose.services.worker = core;
  const databaseNetworks = file.plugins.filter((plugin) => databaseCompanionsOf(plugin).length > 0).map(databaseNetworkOf);
  if (databaseNetworks.length > 0) compose.services.postgres = { networks: ["default", ...databaseNetworks] };
  return compose;
}

/** A container's logical volumes as `volume:path` mounts. */
function mountsOf(plugin: Plugin, volumes: Record<string, string>): string[] {
  return Object.entries(volumes).map(([volume, path]) => `${volumeOf(plugin, volume)}:${path}`);
}

function addPlugin(compose: Compose, plugin: Plugin): void {
  compose.networks[serviceOf(plugin)] = { internal: true };
  for (const container of [plugin, ...plugin.companions]) {
    for (const volume of Object.keys(container.volumes)) compose.volumes[volumeOf(plugin, volume)] = {};
  }
  const mounts = mountsOf(plugin, plugin.volumes);
  compose.services[serviceOf(plugin)] = {
    image: plugin.image,
    restart: "unless-stopped",
    networks: [serviceOf(plugin)],
    mem_limit: plugin.limits.memory,
    cpus: plugin.limits.cpus,
    ...(mounts.length > 0 ? { volumes: mounts } : {}),
  };
  for (const companion of plugin.companions) {
    const names = namesOf(plugin, companion);
    compose.services[names.service] = companionServiceOf(plugin, companion, names, mountsOf(plugin, companion.volumes));
    if (!companion.database) continue;
    compose.networks[databaseNetworkOf(plugin)] = { internal: true };
    compose.services[names.databaseService] = databaseInitOf(plugin, names);
  }
}

/** Adds a proxy and its network, and joins container `service` to them. */
function addProxy(compose: Compose, { name, proxy, container }: ReturnType<typeof egressProxyOf>, service: string): void {
  compose.networks[name] = { internal: true };
  compose.services[name] = proxy;
  const proxied = compose.services[service] ?? {};
  compose.services[service] = {
    ...proxied,
    networks: [...((proxied.networks as string[] | undefined) ?? []), container.network],
    environment: { ...(proxied.environment as Record<string, string> | undefined), ...container.environment },
  };
}

function companionServiceOf(plugin: Plugin, companion: Companion, names: CompanionNames, volumes: string[]): Service {
  const service: Service = { image: companion.image, restart: "unless-stopped", networks: [serviceOf(plugin)] };
  if (volumes.length > 0) service.volumes = volumes;
  if (companion.entrypoint !== undefined) service.entrypoint = companion.entrypoint;
  if (companion.command !== undefined) service.command = companion.command;
  if (companion.healthcheck !== undefined) service.healthcheck = companion.healthcheck;
  const database = companion.database ? databaseOf(plugin, names) : { service: {}, environment: {} };
  const environment = { ...companion.env, ...database.environment };
  if (Object.keys(environment).length > 0) service.environment = environment;
  return { ...service, ...database.service };
}

/** What a companion with `database: true` adds: its network, `DATABASE_URL` and waiting for the database. */
function databaseOf(plugin: Plugin, names: CompanionNames): { service: Service; environment: Record<string, string> } {
  return {
    service: {
      networks: [serviceOf(plugin), databaseNetworkOf(plugin)],
      depends_on: { [names.databaseService]: { condition: "service_completed_successfully" } },
    },
    environment: { DATABASE_URL: `postgres://${names.database}:\${${names.passwordVariable}}@postgres:5432/${names.database}` },
  };
}

/**
 * Creates the role and database (UTF8 with C collation, which Synapse requires; a database created
 * before keeps its collation), or sets the role's password again, and keeps every other role out
 * of it and of the core's database. It runs before the companion on every start, so a plugin added
 * later gets its database too.
 */
const databaseInitSql = [
  String.raw`SELECT format('CREATE ROLE %I LOGIN', :'name') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'name')\gexec`,
  String.raw`SELECT format('ALTER ROLE %I PASSWORD %L', :'name', :'password')\gexec`,
  String.raw`SELECT format('CREATE DATABASE %I OWNER %I ENCODING %L LC_COLLATE %L LC_CTYPE %L TEMPLATE template0', :'name', :'name', 'UTF8', 'C', 'C') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'name')\gexec`,
  String.raw`SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'name')\gexec`,
  String.raw`SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database())\gexec`,
].join("\n");

/** The one-shot service running that SQL, on the plugin's internal database network only. */
function databaseInitOf(plugin: Plugin, names: CompanionNames): Service {
  return {
    image: "postgres:17",
    restart: "no",
    networks: [databaseNetworkOf(plugin)],
    environment: {
      PGHOST: "postgres",
      // compose.yaml fixes the user and database of the core as family_agenda.
      PGUSER: "family_agenda",
      PGDATABASE: "family_agenda",
      PGPASSWORD: "${POSTGRES_PASSWORD:-family_agenda}",
      DATABASE_NAME: names.database,
      DATABASE_PASSWORD: `\${${names.passwordVariable}}`,
      INIT_SQL: databaseInitSql,
    },
    command: [
      "sh",
      "-c",
      'printf "%s\\n" "$$INIT_SQL" | psql -v ON_ERROR_STOP=1 -v name="$$DATABASE_NAME" -v password="$$DATABASE_PASSWORD"',
    ],
    depends_on: { postgres: { condition: "service_healthy" } },
  };
}

function coreServiceOf(file: PluginsFile): Service {
  return {
    environment: {
      PLUGIN_URLS: file.plugins.map((plugin) => `${plugin.id}=http://${serviceOf(plugin)}:8080`).join(","),
      PLUGIN_EGRESS: egressOf(file),
      PLUGIN_EGRESS_TOKENS: egressTokensOf(file),
    },
    networks: ["default", ...file.plugins.map(serviceOf)],
  };
}

/**
 * The egress hosts per container, such as `plugin-demo=api.example.com:443;*.example.org:443`,
 * containers separated by commas, which the api serves to their egress proxies (ADR-0001).
 */
function egressOf(file: PluginsFile): string {
  const entries = file.plugins.flatMap((plugin) => [
    { service: serviceOf(plugin), hosts: plugin.egress },
    ...plugin.companions.map((companion) => ({ service: namesOf(plugin, companion).service, hosts: companion.egress })),
  ]);
  return entries
    .filter((entry) => entry.hosts.length > 0)
    .map((entry) => `${entry.service}=${entry.hosts.join(";")}`)
    .join(",");
}
