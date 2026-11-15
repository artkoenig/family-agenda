import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FamilyId } from "@family-agenda/adapters";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { readSuppliedConfig } from "../../src/config";
import { contextHeader, sealContext } from "../../src/context/context";
import { serveSupplied } from "../../src/context/serve-supplied";

const contextKey = "a-context-key-of-at-least-32-characters";

describe("starting a core in supplied mode", () => {
  it("listens on the caller port only, not on PORT, and offers no Triggered operations", async () => {
    const free = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => {
          resolve(port);
        });
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "family-agenda-supplied-"));
    const config = readSuppliedConfig({ CONTEXT_MODE: "supplied", CONTEXT_KEY: contextKey, PORT: String(free), CALLER_PORT: "0", TESSDATA_DIRECTORY: join(directory, "tessdata"), BUNDLED_TESSDATA_DIRECTORY: "" });
    const core = await serveSupplied(config, { info: () => {}, warn: () => {} });
    try {
      await expect(fetch(`http://127.0.0.1:${free}/api/health`)).rejects.toThrow();
      expect((await fetch(`http://127.0.0.1:${core.port}/setup`)).status).toBe(401);
    } finally {
      await core.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts without a database, a master key file or a blob directory of its own", async () => {
    const directory = await mkdtemp(join(tmpdir(), "family-agenda-supplied-"));
    const lines: string[] = [];
    const log = { info: (line: string) => lines.push(line), warn: (line: string) => lines.push(line) };
    const config = readSuppliedConfig({ CONTEXT_MODE: "supplied", CONTEXT_KEY: contextKey, CALLER_PORT: "0", TESSDATA_DIRECTORY: join(directory, "tessdata"), BUNDLED_TESSDATA_DIRECTORY: "" });
    const core = await serveSupplied(config, log);
    try {
      const health = await fetch(`http://127.0.0.1:${core.port}/api/health`);
      expect(health.status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${core.port}/setup`)).status).toBe(401);
      const lost = sealContext(contextKey, {
        familyId: "0b8f3c1e-5d7a-4c2b-9e6f-1a2b3c4d5e6f" as FamilyId,
        databaseUrl: "postgres://family:secret-password@127.0.0.1:1/none",
        familyKey: Buffer.alloc(32, 7).toString("base64url"),
        blobDirectory: join(directory, "blobs"),
        timeZone: "Europe/Berlin",
        publicUrl: "https://a.example.org",
        expiresAt: Date.now() + 60_000,
      });
      expect((await fetch(`http://127.0.0.1:${core.port}/setup`, { headers: { [contextHeader]: lost } })).status).toBe(503);
      expect(await readdir(directory)).toEqual(["tessdata"]);
      expect(lines).toContain("Triggered operations are off in supplied mode");
      expect(lines.join("\n")).toContain("caller port");
      expect(lines.join("\n")).not.toContain("secret-password");
    } finally {
      await core.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
