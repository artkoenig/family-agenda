import { createHash, timingSafeEqual } from "node:crypto";
import type { Clock, FamilyRepository } from "./ports";

export type RecoveryKitDeps = {
  clock: Clock;
  families: FamilyRepository;
  /** The Instance's master key, which the SecretStore wraps data keys with. */
  masterKey: Uint8Array;
};

export type RecoveryKit = {
  /**
   * The master key in groups of four hex digits, the last group a checksum against typos.
   * A restore needs it to read the Source credentials of a Backup, and the backup key is
   * derived from it.
   */
  masterKey: string;
};

const checksumLength = 2;

export function createRecoveryKitAccess(deps: RecoveryKitDeps) {
  const { clock, families, masterKey } = deps;
  // Once confirmed, the kit never needs confirming again, so the answer is kept.
  let confirmed = false;

  return {
    contents(): RecoveryKit {
      const withChecksum = Buffer.concat([masterKey, checksumOf(masterKey)]);
      const groups = withChecksum.toString("hex").toUpperCase().match(/.{4}/g) ?? [];
      return { masterKey: groups.join("-") };
    },

    /** Whether an Admin has confirmed saving the kit; until then, the Admin area shows only the kit. */
    async isConfirmed(): Promise<boolean> {
      confirmed ||= await families.recoveryKitConfirmed();
      return confirmed;
    },

    async confirm(): Promise<void> {
      await families.confirmRecoveryKit(clock.now());
      confirmed = true;
    },
  };
}

export type RecoveryKitAccess = ReturnType<typeof createRecoveryKitAccess>;

/** The master key a Recovery Kit holds, or null if it is mistyped. */
export function readRecoveryKitKey(masterKey: string): Uint8Array | null {
  const hex = masterKey.replace(/[\s-]/g, "");
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length <= checksumLength) return null;
  const key = bytes.subarray(0, -checksumLength);
  const checksum = bytes.subarray(-checksumLength);
  return timingSafeEqual(checksum, checksumOf(key)) ? new Uint8Array(key) : null;
}

function checksumOf(key: Uint8Array): Buffer {
  return createHash("sha256").update(key).digest().subarray(0, checksumLength);
}
