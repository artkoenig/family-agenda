import { readFile } from "node:fs/promises";
import { readRecoveryKitKey } from "@family-agenda/application";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";

describe("Recovery Kit", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("must be confirmed on a new Instance, and stays confirmed", async () => {
    expect(await instance.app.recoveryKit.isConfirmed()).toBe(false);

    await instance.app.recoveryKit.confirm();
    await instance.restart();

    expect(await instance.app.recoveryKit.isConfirmed()).toBe(true);
  });

  it("holds the master key, so that a restore can recover it", async () => {
    const kit = instance.app.recoveryKit.contents();

    const recovered = readRecoveryKitKey(kit.masterKey);

    expect(recovered).toEqual(new Uint8Array(await readFile(instance.masterKeyFile)));
  });

  it("is read back regardless of spacing and case, but not with a typo", () => {
    const { masterKey } = instance.app.recoveryKit.contents();
    expect(masterKey).toMatch(/^([0-9A-F]{4}-){16}[0-9A-F]{4}$/);

    expect(readRecoveryKitKey(` ${masterKey.toLowerCase().replaceAll("-", " ")}\n`)).not.toBeNull();
    const typo = masterKey.replace(/^./, (digit) => (digit === "0" ? "1" : "0"));
    expect(readRecoveryKitKey(typo)).toBeNull();
    expect(readRecoveryKitKey(masterKey.slice(0, -5))).toBeNull();
  });
});
