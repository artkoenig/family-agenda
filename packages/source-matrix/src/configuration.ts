import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MatrixInstance } from "./instance";

/** Where the worker keeps Synapse and the bridges, and how the `api` container reaches them. */
export type MatrixLayout = {
  /** The `matrix-data` volume, only the worker's: configuration, secrets, media and bridge sessions. */
  dataDirectory: string;
  /** The file in the `matrix-instance` volume that tells the `api` container how to reach them. */
  instanceFile: string;
  /** The name the `api` container reaches the worker's container by, such as `worker`. */
  host: string;
  /** The name in the homeserver's user ids; it never leaves the Instance. */
  serverName: string;
  ports: { synapse: number; bridges: { whatsapp: number } };
  /** Synapse's own database and role on the Instance's Postgres server. */
  database: { host: string; port: number; name: string; user: string };
};

/** The secrets generated on the first start and kept in the data volume. */
export type MatrixSecrets = {
  databasePassword: string;
  registrationSharedSecret: string;
  macaroonSecretKey: string;
  formSecret: string;
  bridges: { whatsapp: BridgeSecrets };
};

type BridgeSecrets = { asToken: string; hsToken: string; senderLocalpart: string; provisioningSecret: string };

const secret = () => randomBytes(32).toString("base64url");

/** The paths of the files the worker writes into the data volume. */
export function pathsOf(layout: MatrixLayout) {
  const synapse = join(layout.dataDirectory, "synapse");
  const whatsapp = join(layout.dataDirectory, "whatsapp");
  return {
    secrets: join(layout.dataDirectory, "secrets.json"),
    synapse: { directory: synapse, config: join(synapse, "homeserver.yaml") },
    whatsapp: { directory: whatsapp, config: join(whatsapp, "config.yaml"), registration: join(whatsapp, "registration.yaml") },
  };
}

/** The secrets of the data volume, generated where missing and kept from then on. */
export async function secretsOf(layout: MatrixLayout): Promise<MatrixSecrets> {
  const file = pathsOf(layout).secrets;
  await mkdir(layout.dataDirectory, { recursive: true });
  const stored = await readJson<Partial<MatrixSecrets>>(file);
  const secrets: MatrixSecrets = {
    databasePassword: secretOr(stored?.databasePassword),
    registrationSharedSecret: secretOr(stored?.registrationSharedSecret),
    macaroonSecretKey: secretOr(stored?.macaroonSecretKey),
    formSecret: secretOr(stored?.formSecret),
    bridges: bridgesOf(stored?.bridges),
  };
  await write(file, `${JSON.stringify(secrets, null, 2)}\n`);
  return secrets;
}

function secretOr(stored: string | undefined): string {
  return stored ?? secret();
}

function bridgesOf(stored: MatrixSecrets["bridges"] | undefined): MatrixSecrets["bridges"] {
  return {
    ...stored,
    whatsapp: stored?.whatsapp ?? {
      asToken: secret(),
      hsToken: secret(),
      senderLocalpart: `bridge-${randomBytes(8).toString("hex")}`,
      provisioningSecret: secret(),
    },
  };
}

/**
 * Writes the configuration of Synapse and the bridges, and the file that tells the `api`
 * container how to reach them. The files are written anew on every start, so that an update of
 * Family Agenda brings its settings along; the secrets and Synapse's signing key are kept.
 */
export async function writeConfiguration(layout: MatrixLayout, secrets: MatrixSecrets): Promise<void> {
  const paths = pathsOf(layout);
  for (const directory of [paths.synapse.directory, paths.whatsapp.directory, dirname(layout.instanceFile)]) {
    await mkdir(directory, { recursive: true });
  }

  const signingKey = join(paths.synapse.directory, "signing.key");
  if ((await readFile(signingKey, "utf8").catch(() => null)) === null) {
    await write(signingKey, `ed25519 a_${randomBytes(2).toString("hex")} ${signingSeed()}\n`);
  }

  const local = (port: number) => `http://127.0.0.1:${port}`;
  const bridgeUrl = local(layout.ports.bridges.whatsapp);
  await write(join(paths.synapse.directory, "log.yaml"), synapseLogging);
  await write(paths.synapse.config, synapseConfig(layout, secrets, paths.synapse.directory, [paths.whatsapp.registration]));
  await write(paths.whatsapp.registration, registration(layout.serverName, bridgeUrl, secrets.bridges.whatsapp));
  await write(paths.whatsapp.config, whatsappConfig(layout, paths.whatsapp.directory, secrets.bridges.whatsapp));

  const reached = (port: number) => `http://${layout.host}:${port}`;
  const instance: MatrixInstance = {
    homeserver: { url: reached(layout.ports.synapse), serverName: layout.serverName, registrationSharedSecret: secrets.registrationSharedSecret },
    bridges: { whatsapp: { url: reached(layout.ports.bridges.whatsapp), provisioningSecret: secrets.bridges.whatsapp.provisioningSecret } },
  };
  await write(layout.instanceFile, `${JSON.stringify(instance, null, 2)}\n`);
}

/** An ed25519 seed as Synapse keeps it: the 32 bytes of the private key, unpadded base64. */
function signingSeed(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return der.subarray(der.length - 32).toString("base64").replace(/=+$/, ""); // eslint-disable-line sonarjs/super-linear-regex -- single-char quantifier anchored at end is O(n)
}

/** A YAML scalar; JSON strings are valid YAML. */
const q = (value: string) => JSON.stringify(value);

const header = "# Written by Family Agenda's worker on every start; changes here are overwritten.";

/** Warnings and errors only, to the worker's log. */
const synapseLogging = `${header}
version: 1
formatters:
  plain:
    format: "%(name)s %(levelname)s %(message)s"
handlers:
  console:
    class: logging.StreamHandler
    formatter: plain
root:
  level: WARNING
  handlers: [console]
disable_existing_loggers: false
`;

/**
 * Synapse serving only the Instance: no federation, no registration but the shared-secret one the
 * plugin uses, no presence, and its media in the data volume.
 */
function synapseConfig(layout: MatrixLayout, secrets: MatrixSecrets, directory: string, registrations: string[]): string {
  return `${header}
server_name: ${q(layout.serverName)}
public_baseurl: ${q(`http://${layout.host}:${layout.ports.synapse}/`)}
listeners:
  # Only the client API, on the Instance's internal network: no federation listener, no published port.
  - port: ${layout.ports.synapse}
    type: http
    bind_addresses: ["0.0.0.0"]
    tls: false
    x_forwarded: false
    resources:
      - names: [client]
        compress: false
database:
  name: psycopg2
  args:
    user: ${q(layout.database.user)}
    password: ${q(secrets.databasePassword)}
    dbname: ${q(layout.database.name)}
    host: ${q(layout.database.host)}
    port: ${layout.database.port}
    cp_min: 1
    cp_max: 5
log_config: ${q(join(directory, "log.yaml"))}
media_store_path: ${q(join(directory, "media"))}
signing_key_path: ${q(join(directory, "signing.key"))}
report_stats: false
enable_registration: false
registration_shared_secret: ${q(secrets.registrationSharedSecret)}
macaroon_secret_key: ${q(secrets.macaroonSecretKey)}
form_secret: ${q(secrets.formSecret)}
# Federation is off: no other homeserver is ever contacted or let in.
federation_domain_whitelist: []
trusted_key_servers: []
allow_public_rooms_over_federation: false
allow_public_rooms_without_auth: false
presence:
  enabled: false
url_preview_enabled: false
# A newly linked account brings dozens of chats at once, whose invitations a Source accepts in one run;
# a join is also an event its user sends, so the limit on sending events must let them through too.
rc_joins:
  local:
    per_second: 10
    burst_count: 1000
rc_message:
  per_second: 10
  burst_count: 1000
app_service_config_files:
${registrations.map((file) => `  - ${q(file)}`).join("\n")}
`;
}

function registration(serverName: string, url: string, bridge: BridgeSecrets): string {
  const domain = serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `${header}
id: whatsapp
url: ${q(url)}
as_token: ${q(bridge.asToken)}
hs_token: ${q(bridge.hsToken)}
sender_localpart: ${q(bridge.senderLocalpart)}
rate_limited: false
namespaces:
  users:
    - regex: ${q(`^@whatsappbot:${domain}$`)}
      exclusive: true
    - regex: ${q(`^@whatsapp_.*:${domain}$`)}
      exclusive: true
`;
}

/**
 * mautrix-whatsapp, receive only: it never shows the account online or typing, and it gets no
 * read receipts or typing notifications from Matrix to pass on. Its session stays in SQLite in
 * the data volume, outside Postgres. The bridge adds its defaults for everything else.
 */
function whatsappConfig(layout: MatrixLayout, directory: string, bridge: BridgeSecrets): string {
  const port = layout.ports.bridges.whatsapp;
  return `${header}
network:
  os_name: Family Agenda
  browser_name: unknown
  send_presence_on_typing: false
  force_active_delivery_receipts: false
  enable_status_broadcast: false
  disable_status_broadcast_send: true
  call_start_notices: false
  url_previews: false
bridge:
  personal_filtering_spaces: false
  bridge_notices: false
  bridge_status_notices: none
  permissions:
    ${q(layout.serverName)}: user
database:
  type: sqlite3-fk-wal
  uri: ${q(`file:${join(directory, "mautrix-whatsapp.db")}?_txlock=immediate`)}
homeserver:
  address: ${q(`http://127.0.0.1:${layout.ports.synapse}`)}
  domain: ${q(layout.serverName)}
appservice:
  address: ${q(`http://127.0.0.1:${port}`)}
  # On every address, so that the \`api\` container reaches its provisioning API.
  hostname: 0.0.0.0
  port: ${port}
  id: whatsapp
  bot:
    username: whatsappbot
    displayname: WhatsApp bridge bot
  # No read receipts or typing notifications from Matrix, so none reach WhatsApp.
  ephemeral_events: false
  as_token: ${q(bridge.asToken)}
  hs_token: ${q(bridge.hsToken)}
  username_template: whatsapp_{{.}}
matrix:
  message_status_events: false
  delivery_receipts: false
  message_error_notices: false
  federate_rooms: false
provisioning:
  shared_secret: ${q(bridge.provisioningSecret)}
  allow_matrix_auth: false
backfill:
  enabled: true
  max_initial_messages: 50
  max_catchup_messages: 500
encryption:
  allow: false
logging:
  min_level: warn
  writers:
    - type: stdout
      format: json
`;
}

async function write(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
