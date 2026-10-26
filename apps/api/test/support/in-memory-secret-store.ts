import { randomUUID } from "node:crypto";
import type { SecretRef, SecretStore } from "@family-butler/application";

/** Keeps secrets in memory and in clear text, for use cases that do not care how they are kept. */
export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<SecretRef, string>();

  put(plaintext: string): Promise<SecretRef> {
    const ref = randomUUID() as SecretRef;
    this.secrets.set(ref, plaintext);
    return Promise.resolve(ref);
  }

  get(ref: SecretRef): Promise<string | null> {
    return Promise.resolve(this.secrets.get(ref) ?? null);
  }

  remove(ref: SecretRef): Promise<void> {
    this.secrets.delete(ref);
    return Promise.resolve();
  }
}
