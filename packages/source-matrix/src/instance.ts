import { readFile } from "node:fs/promises";

/**
 * How the plugin reaches the Instance's homeserver and bridges, as the Matrix Compose profile
 * writes it into a file shared with the `api` and `worker` containers.
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

/** The default place of the file, in the volume the Matrix profile shares with the Instance. */
export const defaultInstanceFile = "/var/lib/family-agenda/matrix/instance.json";

/**
 * The Instance's Matrix setup: given, or read from its file each time, so that a profile enabled
 * later is seen without restarting. Null when the Matrix profile has not run.
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
  if (!homeserver || typeof homeserver.url !== "string" || typeof homeserver.serverName !== "string") return null;
  if (typeof homeserver.registrationSharedSecret !== "string") return null;
  const bridges: MatrixInstance["bridges"] = {};
  for (const [id, bridge] of Object.entries(raw.bridges ?? {})) {
    if (typeof bridge.url === "string" && typeof bridge.provisioningSecret === "string") bridges[id] = bridge;
  }
  return { homeserver, bridges };
}
