import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const masterKeyLength = 32;

/**
 * Reads the master key from its file, creating the file with a new key on first start.
 * The key lives only in this file, never in Postgres (ADR-0006).
 */
export async function loadOrCreateMasterKey(path: string): Promise<Buffer> {
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
  const key = await readFile(path);
  if (key.length !== masterKeyLength) {
    throw new Error(`The master key file ${path} does not hold a ${masterKeyLength}-byte key`);
  }
  return key;
}
