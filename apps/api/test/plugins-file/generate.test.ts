import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { generatePluginsCompose } from "../../src/plugins-file/generate";
import { isPinned, pluginsFileJsonSchema, pluginsSchemaFile } from "../../src/plugins-file/schema";

const password = () => "secret";

function generated(yml: string, dotEnv: string | null = null) {
  const result = generatePluginsCompose(yml, dotEnv, password);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return { compose: parse(result.compose) as ParsedCompose, text: result.compose, dotEnv: result.dotEnv };
}

type ParsedService = { image?: string; environment?: Record<string, string>; networks?: string[]; depends_on?: unknown; ports?: unknown; healthcheck?: unknown };
type ParsedCompose = { services: Record<string, ParsedService>; networks: Record<string, unknown>; volumes: Record<string, unknown> };

function errorsOf(yml: string): string[] {
  const result = generatePluginsCompose(yml, null, password);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

const matrix = `
plugins:
  - id: demo
    image: ghcr.io/org/demo:1.0.0
    egress: [api.example.com:443]
  - id: matrix
    image: ghcr.io/org/matrix@sha256:${"a".repeat(64)}
    limits: { memory: 1g, cpus: 2 }
    companions:
      - name: synapse
        image: matrixdotorg/synapse:v1.163.2
        env: { SYNAPSE_REPORT_STATS: "no" }
        volumes: { data: /data }
        command: [run]
        egress: ["*.whatsapp.net:443"]
        database: true
        healthcheck: { test: [CMD, curl, -f, http://localhost:8008/health] }
`;

describe("generatePluginsCompose", () => {
  it("runs each plugin on its own internal network, unpublished, with default limits and restart", () => {
    const { compose, text } = generated(matrix);

    expect(text.startsWith("# Generated from plugins.yml")).toBe(true);
    expect(compose.services["plugin-demo"]).toEqual({
      image: "ghcr.io/org/demo:1.0.0",
      restart: "unless-stopped",
      networks: ["plugin-demo"],
      mem_limit: "512m",
      cpus: 1,
    });
    expect(compose.services["plugin-matrix"]).toMatchObject({ mem_limit: "1g", cpus: 2 });
    expect(compose.networks["plugin-demo"]).toEqual({ internal: true });
    expect(Object.values(compose.services).filter((service) => service.ports !== undefined)).toEqual([]);
    expect(compose.services["plugin-matrix"]?.healthcheck).toBeUndefined();
  });

  it("binds api and worker to every plugin and lists the egress hosts per container", () => {
    const { compose } = generated(matrix);

    for (const core of [compose.services.api, compose.services.worker]) {
      expect(core?.environment).toEqual({
        PLUGIN_URLS: "demo=http://plugin-demo:8080,matrix=http://plugin-matrix:8080",
        PLUGIN_EGRESS: "plugin-demo=api.example.com:443,plugin-matrix-synapse=*.whatsapp.net:443",
      });
      expect(core?.networks).toEqual(["default", "plugin-demo", "plugin-matrix"]);
    }
  });

  it("runs companions with their volumes, command, healthcheck and a database of their own", () => {
    const { compose } = generated(matrix);

    expect(compose.services["plugin-matrix-synapse"]).toEqual({
      image: "matrixdotorg/synapse:v1.163.2",
      restart: "unless-stopped",
      networks: ["plugin-matrix", "plugin-matrix-database"],
      volumes: ["plugin-matrix-data:/data"],
      command: ["run"],
      healthcheck: { test: ["CMD", "curl", "-f", "http://localhost:8008/health"] },
      depends_on: { "plugin-matrix-synapse-database": { condition: "service_completed_successfully" } },
      environment: {
        SYNAPSE_REPORT_STATS: "no",
        DATABASE_URL: "postgres://plugin_matrix_synapse:${PLUGIN_MATRIX_SYNAPSE_DATABASE_PASSWORD}@postgres:5432/plugin_matrix_synapse",
      },
    });
    expect(compose.volumes).toEqual({ "plugin-matrix-data": {} });
    expect(compose.services.postgres).toEqual({ networks: ["default", "plugin-matrix-database"] });
    const init = compose.services["plugin-matrix-synapse-database"];
    expect(init?.environment).toMatchObject({ DATABASE_NAME: "plugin_matrix_synapse", DATABASE_PASSWORD: "${PLUGIN_MATRIX_SYNAPSE_DATABASE_PASSWORD}" });
    expect(init?.environment?.INIT_SQL).toContain("CREATE DATABASE");
    expect(init?.networks).toEqual(["plugin-matrix-database"]);
    expect(init?.environment?.INIT_SQL).toContain("REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()");
    expect(init?.depends_on).toEqual({ postgres: { condition: "service_healthy" } });
  });

  it("runs a bare companion with nothing but its image", () => {
    const { compose } = generated("plugins:\n  - id: a\n    image: a:1\n    companions: [{ name: b, image: b:1 }]\n");

    expect(compose.services["plugin-a-b"]).toEqual({ image: "b:1", restart: "unless-stopped", networks: ["plugin-a"] });
  });

  it("adds a password to .env for each new database and keeps those already there", () => {
    expect(generated(matrix).dotEnv).toBe("PLUGIN_MATRIX_SYNAPSE_DATABASE_PASSWORD=secret\n");
    expect(generated(matrix, "PORT=8080").dotEnv).toBe("PORT=8080\nPLUGIN_MATRIX_SYNAPSE_DATABASE_PASSWORD=secret\n");
    expect(generated(matrix, "PLUGIN_MATRIX_SYNAPSE_DATABASE_PASSWORD=old\n").dotEnv).toBeNull();
  });

  it("leaves postgres alone and binds nothing for an empty file", () => {
    const { compose, dotEnv } = generated("");

    expect(compose.services.postgres).toBeUndefined();
    expect(compose.services.api?.environment).toEqual({ PLUGIN_URLS: "", PLUGIN_EGRESS: "" });
    expect(dotEnv).toBeNull();
  });

  it("rejects invalid files with the path of each mistake", () => {
    expect(errorsOf("plugins: [")[0]).toMatch(/^plugins.yml is not YAML/);
    expect(errorsOf("plugins:\n  - id: demo\n    image: demo:latest\n")).toEqual([
      "plugins.yml.plugins.0.image: must be pinned to a tag other than latest or to a sha256 digest, such as ghcr.io/org/plugin:1.2.0",
    ]);
    expect(errorsOf("plugins:\n  - id: Demo\n    image: demo:1\n    egress: [example.com]\n    extra: 1\n")).toHaveLength(3);
  });
});

describe("name collisions", () => {
  it.each([
    ["the same plugin twice", "plugins:\n  - { id: a, image: a:1 }\n  - { id: a, image: a:1 }\n", "plugin a and plugin a both make the service plugin-a"],
    ["a companion twice", "plugins:\n  - id: a\n    image: a:1\n    companions: [{ name: b, image: b:1 }, { name: b, image: b:1 }]\n", "companion b of plugin a and companion b of plugin a both make the service plugin-a-b"],
    ["a companion and a plugin", "plugins:\n  - id: a\n    image: a:1\n    companions: [{ name: b, image: b:1 }]\n  - { id: a-b, image: a:1 }\n", "plugin a-b and companion b of plugin a both make the service plugin-a-b"],
    ["a database init and a companion", "plugins:\n  - id: a\n    image: a:1\n    companions: [{ name: b, image: b:1, database: true }, { name: b-database, image: b:1 }]\n", "companion b-database of plugin a and companion b of plugin a both make the service plugin-a-b-database"],
    ["volumes of two plugins", "plugins:\n  - id: a\n    image: a:1\n    companions: [{ name: c, image: c:1, volumes: { b-data: /d } }]\n  - id: a-b\n    image: a:1\n    companions: [{ name: c, image: c:1, volumes: { data: /d } }]\n", "plugin a-b and plugin a both make the volume plugin-a-b-data"],
  ])("rejects %s", (_, yml, message) => {
    expect(errorsOf(yml)).toContain(`plugins.yml: ${message}; rename one`);
  });
});

describe("isPinned", () => {
  it.each([
    ["ghcr.io/org/plugin:1.2.0", true],
    ["registry:5000/plugin:1", true],
    ["plugin@sha256:abc", false],
    [`plugin@sha256:${"0".repeat(64)}`, true],
    ["plugin", false],
    ["registry:5000/plugin", false],
    ["plugin:latest", false],
    ["plugin:", false],
  ])("%s → %s", (image, pinned) => {
    expect(isPinned(image)).toBe(pinned);
  });
});

describe("plugins.schema.json", () => {
  it("is what the repository root holds; after a change, run `pnpm plugins-schema`", () => {
    const written = readFileSync(pluginsSchemaFile, "utf8");

    expect(written).toBe(`${JSON.stringify(pluginsFileJsonSchema(), null, 2)}\n`);
  });
});
