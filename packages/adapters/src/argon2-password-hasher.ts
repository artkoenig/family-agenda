import { hash, verify } from "@node-rs/argon2";
import type { PasswordHasher } from "@family-butler/application";

/** Argon2id (the library's default algorithm) with its default cost parameters. */
export class Argon2idPasswordHasher implements PasswordHasher {
  hash(password: string): Promise<string> {
    return hash(password);
  }

  verify(passwordHash: string, password: string): Promise<boolean> {
    return verify(passwordHash, password);
  }
}
