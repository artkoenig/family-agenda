import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FamilyId } from "@family-agenda/adapters";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { readSuppliedConfig } from "../../src/config";

const oidc = { OIDC_ISSUER_URL: "https://id.example.org", OIDC_CLIENT_ID: "family-agenda", OIDC_CLIENT_SECRET: "s3cret", OIDC_CALLBACK_URL: "https://sign-in.example.org/sso/callback" };
import { contextHeader, sealContext } from "../../src/context/context";
import { serveSupplied } from "../../src/context/serve-supplied";

const contextKey = "a-context-key-of-at-least-32-characters";

describe("starting a core in supplied mode", () => {
  it("listens on the caller port only, not on PORT", async () => {
    const free = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => {
          resolve(port);
        });
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "family-agenda-supplied-"));
    const config = readSuppliedConfig({ ...oidc, CONTEXT_MODE: "supplied", CONTEXT_KEY: contextKey, PORT: String(free), CALLER_PORT: "0", TESSDATA_DIRECTORY: join(directory, "tessdata"), BUNDLED_TESSDATA_DIRECTORY: "" });
    const core = await serveSupplied(config, { info: () => {}, warn: () => {}, error: () => {} });
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
    const log = { info: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
    const config = readSuppliedConfig({ ...oidc, CONTEXT_MODE: "supplied", CONTEXT_KEY: contextKey, CALLER_PORT: "0", TESSDATA_DIRECTORY: join(directory, "tessdata"), BUNDLED_TESSDATA_DIRECTORY: "" });
    const core = await serveSupplied(config, log);
    try {
      const health = await fetch(`http://127.0.0.1:${core.port}/api/health`);
      expect(health.status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${core.port}/setup`)).status).toBe(401);
      // The one sign-in callback answers without a Context: here, a state it did not seal, refused.
      const callback = await fetch(`http://127.0.0.1:${core.port}/sso/callback?code=x&state=forged`, { redirect: "manual" });
      expect([callback.status, callback.headers.get("location")]).toEqual([400, null]);
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
      expect(lines).toContain("Triggered operations are off: TRIGGER_TOKEN is not set");
      expect(lines.join("\n")).toContain("caller port");
      expect(lines.join("\n")).not.toContain("secret-password");
    } finally {
      await core.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("with a trigger token, offers the Triggered operations on their port, each refused without a Context, opening no database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "family-agenda-supplied-"));
    const lines: string[] = [];
    const log = { info: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
    const triggerPort = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => {
          resolve(port);
        });
      });
    });
    const config = readSuppliedConfig({ ...oidc, CONTEXT_MODE: "supplied", CONTEXT_KEY: contextKey, CALLER_PORT: "0", TRIGGER_PORT: String(triggerPort), TRIGGER_TOKEN: "s3cret-token", TESSDATA_DIRECTORY: join(directory, "tessdata"), BUNDLED_TESSDATA_DIRECTORY: "" });
    const core = await serveSupplied(config, log);
    try {
      expect((await fetch(`http://127.0.0.1:${core.port}/api/health`)).status).toBe(200);
      const url = `http://127.0.0.1:${triggerPort}/operations/due-work`;
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      const answer = await fetch(url, { method: "POST", headers: { authorization: "Bearer s3cret-token" } });
      expect([answer.status, await answer.json()]).toEqual([401, { error: "invalid-context" }]);
      expect(lines).toContain(`Triggered operations listening on port ${triggerPort}`);
      expect(await readdir(directory)).toEqual(["tessdata"]);
    } finally {
      await core.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
