import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readConfig, readSuppliedConfig } from "../../src/config";

const compose = parse(readFileSync(fileURLToPath(new URL("../../../../compose.yaml", import.meta.url)), "utf8")) as {
  services: Record<string, { ports?: string[]; expose?: string[] }>;
};

describe("the port of triggered operations", () => {
  it("is not published by the compose file, which publishes only the pages", () => {
    const { trigger: { port: triggerPort }, port } = readConfig({ DATABASE_URL: "postgres://x" });
    const published = Object.values(compose.services).flatMap((service) => service.ports ?? []);

    expect(published).toEqual([`\${PORT:-8080}:${port}`]);
    expect(published.some((mapping) => mapping.endsWith(`:${triggerPort}`))).toBe(false);
  });
});

describe("the caller port of supplied mode", () => {
  it("is not published by the compose file", () => {
    const { callerPort } = readSuppliedConfig({ CONTEXT_MODE: "supplied", CONTEXT_KEY: "a-context-key-of-at-least-32-characters", CALLER_PORT: "3002", OIDC_ISSUER_URL: "https://id.example.org", OIDC_CLIENT_ID: "family-agenda", OIDC_CLIENT_SECRET: "s3cret" });
    const published = Object.values(compose.services).flatMap((service) => service.ports ?? []);
    expect(published.some((mapping) => mapping.endsWith(`:${callerPort}`))).toBe(false);
  });
});
