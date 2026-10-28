import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secretsOf, writeConfiguration, type MatrixLayout } from "../src/configuration";

describe("the configuration the worker writes for Synapse and the bridges", () => {
  let root: string;
  let layout: MatrixLayout;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agenda-matrix-"));
    layout = {
      dataDirectory: join(root, "data"),
      instanceFile: join(root, "instance", "instance.json"),
      host: "worker",
      serverName: "family-agenda.local",
      ports: { synapse: 8008, bridges: { whatsapp: 29318 } },
      database: { host: "postgres", port: 5432, name: "synapse", user: "synapse" },
    };
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const read = (...path: string[]) => readFile(join(root, ...path), "utf8");
  const write = async () => writeConfiguration(layout, await secretsOf(layout));

  it("keeps Synapse to the Instance: no federation, no registration, no presence", async () => {
    await write();

    const homeserver = await read("data", "synapse", "homeserver.yaml");
    expect(homeserver).toContain("enable_registration: false");
    expect(homeserver).toContain("federation_domain_whitelist: []");
    expect(homeserver).toMatch(/presence:\n {2}enabled: false/);
    expect(homeserver).toContain("      - names: [client]");
    expect(homeserver).not.toContain("federation]");
    expect(homeserver).toContain(`media_store_path: "${join(root, "data", "synapse", "media")}"`);
    expect(homeserver).toContain('host: "postgres"');
    const { databasePassword } = JSON.parse(await read("data", "secrets.json")) as { databasePassword: string };
    expect(homeserver).toContain(`password: "${databasePassword}"`);
    // A Source joins all the chats of a newly linked account in one run.
    expect(homeserver).toMatch(/rc_joins:\n {2}local:\n {4}per_second: 10\n {4}burst_count: 1000/);
    expect(await read("data", "synapse", "signing.key")).toMatch(/^ed25519 a_[0-9a-f]{4} [A-Za-z0-9+/]{43}\n$/);
  });

  it("configures the WhatsApp bridge to receive only, matching its registration and what the api container reads", async () => {
    await write();

    const config = await read("data", "whatsapp", "config.yaml");
    const registration = await read("data", "whatsapp", "registration.yaml");
    const instance = JSON.parse(await read("instance", "instance.json")) as {
      homeserver: { url: string; registrationSharedSecret: string };
      bridges: { whatsapp: { url: string; provisioningSecret: string } };
    };
    expect(config).toContain("send_presence_on_typing: false");
    expect(config).toContain("ephemeral_events: false");
    expect(config).toContain("delivery_receipts: false");
    const asToken = /as_token: "([^"]+)"/.exec(registration)?.[1];
    expect(config).toContain(`as_token: "${asToken}"`);
    expect(registration).toContain(String.raw`regex: "^@whatsapp_.*:family-agenda\\.local$"`);
    expect(registration).toContain('url: "http://127.0.0.1:29318"');
    expect(config).toContain(`shared_secret: "${instance.bridges.whatsapp.provisioningSecret}"`);
    expect(instance.homeserver.url).toBe("http://worker:8008");
    expect(instance.bridges.whatsapp.url).toBe("http://worker:29318");
    expect(await read("data", "synapse", "homeserver.yaml")).toContain(`registration_shared_secret: "${instance.homeserver.registrationSharedSecret}"`);
  });

  it("keeps its secrets and signing key when it runs again", async () => {
    await write();
    const first = [await read("instance", "instance.json"), await read("data", "whatsapp", "registration.yaml"), await read("data", "synapse", "signing.key")];

    await write();

    expect([await read("instance", "instance.json"), await read("data", "whatsapp", "registration.yaml"), await read("data", "synapse", "signing.key")]).toEqual(first);
  });
});
