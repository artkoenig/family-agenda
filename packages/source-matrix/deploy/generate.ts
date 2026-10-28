/**
 * Writes the configuration the Matrix Compose profile runs on (ADR-0011): Synapse's, and for each
 * bridge its configuration and application service registration, plus the file the Matrix plugin
 * reads to reach them. Secrets are generated on the first run and kept; the files are written
 * anew on every run, so that an update of Family Agenda brings its settings along.
 *
 *   node --import tsx packages/source-matrix/deploy/generate.ts
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type GenerateOptions = {
  /** Synapse's data volume, where its configuration, signing key and these secrets live. */
  synapseDirectory: string;
  /** The volume shared read-only with the `api` and `worker` containers. */
  instanceDirectory: string;
  /** Per bridge, its data volume, which holds its configuration and registration. */
  bridgeDirectories: { whatsapp: string };
  /** The name in the homeserver's user ids; it never leaves the Instance. */
  serverName: string;
  /** The password of the `synapse` role on the Instance's Postgres server. */
  databasePassword: string;
};

/** The owners the containers run as: Synapse's image, the bridge's image, and the `node` user of Family Agenda's. */
const owners = { synapse: 991, bridge: 1337, instance: 1000 };

type Secrets = {
  registrationSharedSecret: string;
  macaroonSecretKey: string;
  formSecret: string;
  bridges: Record<string, { asToken: string; hsToken: string; senderLocalpart: string; provisioningSecret: string }>;
};

const secret = () => randomBytes(32).toString("base64url");

export async function generate(options: GenerateOptions): Promise<void> {
  const { synapseDirectory, instanceDirectory, bridgeDirectories, serverName } = options;
  for (const directory of [synapseDirectory, instanceDirectory, ...Object.values(bridgeDirectories)]) {
    await mkdir(directory, { recursive: true });
  }

  const secretsFile = join(synapseDirectory, "family-agenda-secrets.json");
  const stored = await readJson<Partial<Secrets>>(secretsFile);
  const whatsapp = stored?.bridges?.whatsapp ?? {
    asToken: secret(),
    hsToken: secret(),
    senderLocalpart: `bridge-${randomBytes(8).toString("hex")}`,
    provisioningSecret: secret(),
  };
  const secrets: Secrets = {
    registrationSharedSecret: stored?.registrationSharedSecret ?? secret(),
    macaroonSecretKey: stored?.macaroonSecretKey ?? secret(),
    formSecret: stored?.formSecret ?? secret(),
    bridges: { ...stored?.bridges, whatsapp },
  };
  await write(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`, owners.synapse);

  const signingKey = join(synapseDirectory, "signing.key");
  if ((await readFile(signingKey, "utf8").catch(() => null)) === null) {
    await write(signingKey, `ed25519 a_${randomBytes(2).toString("hex")} ${signingSeed()}\n`, owners.synapse);
  }

  const bridgeUrl = "http://mautrix-whatsapp:29318";
  await write(join(synapseDirectory, "homeserver.yaml"), synapseConfig(options, secrets), owners.synapse);
  await write(join(bridgeDirectories.whatsapp, "registration.yaml"), registration(serverName, bridgeUrl, whatsapp), owners.bridge, 0o644);
  await write(join(bridgeDirectories.whatsapp, "config.yaml"), whatsappConfig(serverName, bridgeUrl, whatsapp), owners.bridge);
  await write(
    join(instanceDirectory, "instance.json"),
    `${JSON.stringify(
      {
        homeserver: { url: "http://synapse:8008", serverName, registrationSharedSecret: secrets.registrationSharedSecret },
        bridges: { whatsapp: { url: bridgeUrl, provisioningSecret: whatsapp.provisioningSecret } },
      },
      null,
      2,
    )}\n`,
    owners.instance,
  );
}

/** An ed25519 seed as Synapse keeps it: the 32 bytes of the private key, unpadded base64. */
function signingSeed(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return der.subarray(der.length - 32).toString("base64").replace(/=+$/, "");
}

/** A YAML scalar; JSON strings are valid YAML. */
const q = (value: string) => JSON.stringify(value);

/**
 * Synapse serving only the Instance: no federation, no registration but the shared-secret one the
 * plugin uses, no presence, and its media in a volume of its own.
 */
function synapseConfig(options: GenerateOptions, secrets: Secrets): string {
  return `# Written by the Matrix profile of Family Agenda on every start; changes here are overwritten.
server_name: ${q(options.serverName)}
pid_file: /data/homeserver.pid
public_baseurl: "http://synapse:8008/"
listeners:
  # Only the client API, on the Instance's internal network: no federation listener, no published port.
  - port: 8008
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
    user: synapse
    password: ${q(options.databasePassword)}
    dbname: synapse
    host: postgres
    port: 5432
    cp_min: 2
    cp_max: 5
media_store_path: /media
signing_key_path: /data/signing.key
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
app_service_config_files:
  - /bridges/whatsapp/registration.yaml
`;
}

function registration(serverName: string, url: string, bridge: Secrets["bridges"][string]): string {
  const domain = serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `id: whatsapp
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
 * its own volume, outside Postgres (ADR-0006). The bridge adds its defaults for everything else.
 */
function whatsappConfig(serverName: string, url: string, bridge: Secrets["bridges"][string]): string {
  return `# Written by the Matrix profile of Family Agenda on every start; changes here are overwritten.
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
    ${q(serverName)}: user
database:
  type: sqlite3-fk-wal
  uri: file:/data/mautrix-whatsapp.db?_txlock=immediate
homeserver:
  address: http://synapse:8008
  domain: ${q(serverName)}
appservice:
  address: ${q(url)}
  hostname: 0.0.0.0
  port: 29318
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
  min_level: info
  writers:
    - type: stdout
      format: json
`;
}

async function write(file: string, contents: string, owner: number, mode = 0o600): Promise<void> {
  await writeFile(file, contents, { mode });
  await chmod(file, mode);
  // Only root, as the profile runs this, can hand the files to the containers that read them.
  if (process.getuid?.() === 0) await chown(file, owner, owner);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await generate({
    synapseDirectory: process.env.SYNAPSE_DIRECTORY ?? "/synapse",
    instanceDirectory: process.env.MATRIX_INSTANCE_DIRECTORY ?? "/var/lib/family-agenda/matrix",
    bridgeDirectories: { whatsapp: process.env.WHATSAPP_BRIDGE_DIRECTORY ?? "/bridges/whatsapp" },
    serverName: process.env.MATRIX_SERVER_NAME ?? "family-agenda.local",
    databasePassword: process.env.SYNAPSE_POSTGRES_PASSWORD ?? "synapse",
  });
  console.log("Wrote the configuration of Synapse and its bridges.");
}
