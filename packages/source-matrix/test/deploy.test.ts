import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generate, type GenerateOptions } from "../deploy/generate";

describe("the configuration the Matrix profile generates", () => {
  let root: string;
  let options: GenerateOptions;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agenda-matrix-"));
    options = {
      synapseDirectory: join(root, "synapse"),
      instanceDirectory: join(root, "instance"),
      bridgeDirectories: { whatsapp: join(root, "whatsapp") },
      serverName: "family-agenda.local",
      databasePassword: "db-password",
    };
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const read = (...path: string[]) => readFile(join(root, ...path), "utf8");

  it("keeps Synapse to the Instance: no federation, no registration, no presence", async () => {
    await generate(options);

    const homeserver = await read("synapse", "homeserver.yaml");
    expect(homeserver).toContain("enable_registration: false");
    expect(homeserver).toContain("federation_domain_whitelist: []");
    expect(homeserver).toMatch(/presence:\n {2}enabled: false/);
    expect(homeserver).toContain("      - names: [client]");
    expect(homeserver).not.toContain("federation]");
    expect(homeserver).toContain("media_store_path: /media");
    expect(homeserver).toContain('password: "db-password"');
    expect(await read("synapse", "signing.key")).toMatch(/^ed25519 a_[0-9a-f]{4} [A-Za-z0-9+/]{43}\n$/);
  });

  it("configures the WhatsApp bridge to receive only, matching its registration and the plugin's setup", async () => {
    await generate(options);

    const config = await read("whatsapp", "config.yaml");
    const registration = await read("whatsapp", "registration.yaml");
    const instance = JSON.parse(await read("instance", "instance.json")) as {
      homeserver: { registrationSharedSecret: string };
      bridges: { whatsapp: { url: string; provisioningSecret: string } };
    };
    expect(config).toContain("send_presence_on_typing: false");
    expect(config).toContain("ephemeral_events: false");
    expect(config).toContain("delivery_receipts: false");
    const asToken = /as_token: "([^"]+)"/.exec(registration)?.[1];
    expect(config).toContain(`as_token: "${asToken}"`);
    expect(registration).toContain(String.raw`regex: "^@whatsapp_.*:family-agenda\\.local$"`);
    expect(config).toContain(`shared_secret: "${instance.bridges.whatsapp.provisioningSecret}"`);
    expect(await read("synapse", "homeserver.yaml")).toContain(`registration_shared_secret: "${instance.homeserver.registrationSharedSecret}"`);
  });

  it("keeps its secrets and signing key when it runs again", async () => {
    await generate(options);
    const first = [await read("instance", "instance.json"), await read("whatsapp", "registration.yaml"), await read("synapse", "signing.key")];

    await generate(options);

    expect([await read("instance", "instance.json"), await read("whatsapp", "registration.yaml"), await read("synapse", "signing.key")]).toEqual(first);
  });
});
