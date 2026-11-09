import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const masterKeyLength = 32;

/**
 * The master key from its file, or null if there is no file yet.
 * The key lives only in this file, never in Postgres (ADR-0003).
 */
export async function readMasterKey(path: string): Promise<Buffer | null> {
  let key: Buffer;
  try {
    key = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (key.length !== masterKeyLength) {
    throw new Error(`The master key file ${path} does not hold a ${masterKeyLength}-byte key`);
  }
  return key;
}

/** Creates the master key file with a new key, unless another process just did. */
export async function createMasterKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true });
  // Linked into place, so that `api` and `worker` starting together never read a half-written key.
  const draft = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFile(draft, randomBytes(masterKeyLength), { mode: 0o600 });
  try {
    await link(draft, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(draft);
  }
  const key = await readMasterKey(path);
  if (!key) throw new Error(`The master key file ${path} vanished after creating it`);
  return key;
}
