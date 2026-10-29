import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { SecretRef, SecretStore } from "@family-agenda/application";
import { eq } from "drizzle-orm";
import { masterKeyLength } from "../file-master-key";
import type { Database } from "./database";
import { uuidPattern } from "../uuid";
import { secrets } from "./schema";

const algorithm = "aes-256-gcm";
const ivLength = 12;
const tagLength = 16;
const dataKeyLength = 32;

/** Whether Postgres holds any secret, which only the master key it was stored with can read. */
export async function holdsSecrets(db: Database): Promise<boolean> {
  return (await db.$count(secrets)) > 0;
}

/**
 * Envelope encryption: each secret is encrypted with its own data key, and the data key
 * is wrapped with the master key. Postgres holds only the ciphertexts.
 */
export class EnvelopeSecretStore implements SecretStore {
  constructor(
    private readonly db: Database,
    private readonly masterKey: Buffer,
  ) {
    if (masterKey.length !== masterKeyLength) throw new Error("The master key has the wrong length");
  }

  async put(plaintext: string): Promise<SecretRef> {
    const id = randomUUID();
    // Both ciphertexts are bound to the id, so that rows cannot be swapped.
    const context = Buffer.from(id);
    const dataKey = randomBytes(dataKeyLength);
    try {
      await this.db.insert(secrets).values({
        id,
        wrappedDataKey: seal(this.masterKey, dataKey, context),
        ciphertext: seal(dataKey, Buffer.from(plaintext, "utf8"), context),
      });
    } finally {
      dataKey.fill(0);
    }
    return id as SecretRef;
  }

  async get(ref: SecretRef): Promise<string | null> {
    if (!uuidPattern.test(ref)) return null;
    const [row] = await this.db.select().from(secrets).where(eq(secrets.id, ref));
    if (!row) return null;
    const context = Buffer.from(row.id);
    const dataKey = open(this.masterKey, row.wrappedDataKey, context);
    try {
      return open(dataKey, row.ciphertext, context).toString("utf8");
    } finally {
      dataKey.fill(0);
    }
  }

  async remove(ref: SecretRef): Promise<void> {
    if (!uuidPattern.test(ref)) return;
    await this.db.delete(secrets).where(eq(secrets.id, ref));
  }

  async list(): Promise<{ ref: SecretRef; storedAt: Date }[]> {
    const rows = await this.db.select({ id: secrets.id, createdAt: secrets.createdAt }).from(secrets);
    return rows.map((row) => ({ ref: row.id as SecretRef, storedAt: row.createdAt }));
  }
}

function seal(key: Buffer, plaintext: Buffer, context: Buffer): Buffer {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv(algorithm, key, iv, { authTagLength: tagLength });
  cipher.setAAD(context);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

/** Throws if the key is wrong or the sealed value was tampered with. */
function open(key: Buffer, sealed: Buffer, context: Buffer): Buffer {
  const iv = sealed.subarray(0, ivLength);
  const tag = sealed.subarray(sealed.length - tagLength);
  const decipher = createDecipheriv(algorithm, key, iv, { authTagLength: tagLength });
  decipher.setAAD(context);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(ivLength, -tagLength)), decipher.final()]);
}
