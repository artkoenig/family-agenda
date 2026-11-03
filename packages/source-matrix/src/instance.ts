import { readFile } from "node:fs/promises";

/**
 * How the plugin reaches the Instance's homeserver and bridges, as the worker that runs them
 * writes it into a file shared with the `api` container.
 */
export type MatrixInstance = {
  homeserver: {
    /** The address of Synapse on the Instance's internal network, such as `http://synapse:8008`. */
    url: string;
    /** The name in the homeserver's user ids, such as `family-agenda.local`. */
    serverName: string;
    /** Lets the plugin create a Matrix user for each Source while registration is off. */
    registrationSharedSecret: string;
  };
  /** By Messenger id: its bridge's address and the secret of its provisioning API. */
  bridges: Record<string, { url: string; provisioningSecret: string }>;
};

/** The default place of the file, in the volume the worker shares with the `api` container. */
export const defaultInstanceFile = "/var/lib/family-agenda/matrix/instance.json";

/**
 * The Instance's Matrix setup: given, or read from its file each time, so that a Messenger
 * enabled later is seen without restarting. Null until the worker has set Matrix up.
 */
export function instanceReader(source: MatrixInstance | string): () => Promise<MatrixInstance | null> {
  if (typeof source !== "string") return () => Promise.resolve(source);
  return async () => {
    let text: string;
    try {
      text = await readFile(source, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return parseInstance(JSON.parse(text));
  };
}

function parseInstance(value: unknown): MatrixInstance | null {
  const raw = value as Partial<MatrixInstance> | null;
  const homeserver = raw?.homeserver;
  if (!isHomeserver(homeserver)) return null;
  const bridges = Object.entries(raw?.bridges ?? {}).filter(([, bridge]) => isBridge(bridge));
  return { homeserver, bridges: Object.fromEntries(bridges) };
}

function isHomeserver(value: Partial<MatrixInstance["homeserver"]> | undefined): value is MatrixInstance["homeserver"] {
  return typeof value?.url === "string" && typeof value.serverName === "string" && typeof value.registrationSharedSecret === "string";
}

function isBridge(value: Partial<MatrixInstance["bridges"][string]>): boolean {
  return typeof value.url === "string" && typeof value.provisioningSecret === "string";
}
