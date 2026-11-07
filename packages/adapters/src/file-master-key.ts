import { readFile } from "node:fs/promises";

export const masterKeyLength = 32;

/**
 * The master key from its file, or null if there is no file yet.
 * The key never lives in Postgres (ADR-0006), and nothing creates this file: the Operator supplies it.
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
