import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { proxyImageOf } from "../../src/plugins-file/compose";
import { generatePluginsCompose } from "../../src/plugins-file/generate";
import { isPinned, pluginsFileJsonSchema, pluginsSchemaFile } from "../../src/plugins-file/schema";

const password = () => "secret";

function generated(yml: string, dotEnv: string | null = null) {
  const result = generatePluginsCompose(yml, dotEnv, password);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return { compose: parse(result.compose) as ParsedCompose, text: result.compose, dotEnv: result.dotEnv };
}

type ParsedService = { image?: string; entrypoint?: string[]; command?: string[]; mem_limit?: string; environment?: Record<string, string>; networks?: string[]; depends_on?: unknown; ports?: unknown; healthcheck?: unknown; volumes?: string[] };
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
    volumes: { config: /config }
    companions:
      - name: synapse
        image: matrixdotorg/synapse:v1.163.2
        env: { SYNAPSE_REPORT_STATS: "no" }
        volumes: { data: /data, config: /config }
        entrypoint: [sh, -c]
        command: [run]
        egress: ["*.whatsapp.net:443"]
        database: true
        healthcheck: { test: [CMD, curl, -f, http://localhost:8008/health] }
`;

function proxyEnvironment(container: string, siblings: string): Record<string, string> {
  const url = `http://${container}-egress:3128`;
  const noProxy = ["localhost,127.0.0.1", siblings].filter((part) => part !== "").join(",");
  return { HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url, NO_PROXY: noProxy, no_proxy: noProxy };
}

describe("generatePluginsCompose", () => {
  it("runs each plugin on its own internal network, unpublished, with default limits and restart", () => {
    const { compose, text } = generated(matrix);

    expect(text.startsWith("# Generated from plugins.yml")).toBe(true);
    expect(compose.services["plugin-demo"]).toMatchObject({
      image: "ghcr.io/org/demo:1.0.0",
      restart: "unless-stopped",
      networks: ["plugin-demo", "plugin-demo-egress"],
      mem_limit: "512m",
      cpus: 1,
    });
    expect(compose.services["plugin-matrix"]).toMatchObject({ mem_limit: "1g", cpus: 2, volumes: ["plugin-matrix-config:/config"] });
    expect(compose.services["plugin-demo"]?.volumes).toBeUndefined();
    expect(compose.networks["plugin-demo"]).toEqual({ internal: true });
    expect(Object.values(compose.services).filter((service) => service.ports !== undefined)).toEqual([]);
    expect(compose.services["plugin-matrix"]?.healthcheck).toBeUndefined();
  });

  it("binds api and worker to every plugin, lists the egress hosts per plugin and gives them the ticket key", () => {
    const { compose } = generated(matrix);

    for (const core of [compose.services.api, compose.services.worker]) {
      expect(core?.environment).toEqual({
        PLUGIN_URLS: "demo=http://plugin-demo:8080,matrix=http://plugin-matrix:8080",
        PLUGIN_EGRESS: "plugin-demo=api.example.com:443",
        EGRESS_TICKET_KEY: "${EGRESS_TICKET_KEY}",
      });
      expect(core?.networks).toEqual(["default", "plugin-demo", "plugin-matrix"]);
    }
  });

  it("runs companions with their volumes, entrypoint, command, healthcheck and a database of their own", () => {
    const { compose } = generated(matrix);

    expect(compose.services["plugin-matrix-synapse"]).toEqual({
      image: "matrixdotorg/synapse:v1.163.2",
      restart: "unless-stopped",
      networks: ["plugin-matrix", "plugin-matrix-database", "plugin-matrix-synapse-egress"],
      volumes: ["plugin-matrix-data:/data", "plugin-matrix-config:/config"],
      entrypoint: ["sh", "-c"],
      command: ["run"],
      healthcheck: { test: ["CMD", "curl", "-f", "http://localhost:8008/health"] },
      depends_on: { "plugin-matrix-synapse-database": { condition: "service_completed_successfully" } },
      environment: {
        SYNAPSE_REPORT_STATS: "no",
        ...proxyEnvironment("plugin-matrix-synapse", "plugin-matrix"),
        DATABASE_URL: "postgres://plugin_matrix_synapse:${PLUGIN_MATRIX_SYNAPSE_DATABASE_PASSWORD}@postgres:5432/plugin_matrix_synapse",
      },
    });
    expect(compose.volumes).toEqual({ "plugin-matrix-config": {}, "plugin-matrix-data": {} });
    expect(compose.services.postgres).toEqual({ networks: ["default", "plugin-matrix-database"] });
    const init = compose.services["plugin-matrix-synapse-database"];
    expect(init?.environment).toMatchObject({ DATABASE_NAME: "plugin_matrix_synapse", DATABASE_PASSWORD: "${PLUGIN_MATRIX_SYNAPSE_DATABASE_PASSWORD}" });
    expect(init?.environment?.INIT_SQL).toContain("CREATE DATABASE %I OWNER %I ENCODING %L LC_COLLATE %L LC_CTYPE %L TEMPLATE template0', :'name', :'name', 'UTF8', 'C', 'C'");
    expect(init?.networks).toEqual(["plugin-matrix-database"]);
    expect(init?.environment?.INIT_SQL).toContain("REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()");
    expect(init?.depends_on).toEqual({ postgres: { condition: "service_healthy" } });
  });

  it("gives each plugin and each companion with egress hosts an egress proxy of its own", () => {
    const { compose } = generated(matrix);

    const proxyOf = (container: string, environment: Record<string, string>) => ({
      image: "${EGRESS_PROXY_IMAGE:-family-agenda:local}",
      restart: "unless-stopped",
      command: ["node", "--import", "tsx", "src/egress-proxy-main.ts"],
      environment: { ...environment, PORT: "3128" },
      networks: ["default", `${container}-egress`],
      mem_limit: "128m",
    });
    for (const container of ["plugin-demo", "plugin-matrix", "plugin-matrix-synapse"]) expect(compose.networks[`${container}-egress`]).toEqual({ internal: true });
    // A plugin's own proxy checks the tickets of the core's calls and asks the api what each allows.
    for (const container of ["plugin-demo", "plugin-matrix"]) {
      expect(compose.services[`${container}-egress`]).toEqual(
        proxyOf(container, { EGRESS_ALLOWLIST_URL: `http://api:3001/egress/${container}`, EGRESS_TICKET_KEY: "${EGRESS_TICKET_KEY}" }),
      );
    }
    // The core never calls a companion: its proxy allows its declared hosts.
    expect(compose.services["plugin-matrix-synapse-egress"]).toEqual(proxyOf("plugin-matrix-synapse", { EGRESS_HOSTS: "*.whatsapp.net:443" }));
    expect(compose.services["plugin-demo"]?.environment).toEqual(proxyEnvironment("plugin-demo", ""));
    expect(compose.services["plugin-matrix"]?.environment).toEqual(proxyEnvironment("plugin-matrix", "plugin-matrix-synapse"));
    // Only proxies reach the default network, the one with internet access.
    const onDefault = Object.entries(compose.services).filter(([, service]) => service.networks?.includes("default")).map(([name]) => name);
    expect(onDefault.sort()).toEqual(["api", "plugin-demo-egress", "plugin-matrix-egress", "plugin-matrix-synapse-egress", "postgres", "worker"]);
  });

  it("runs the proxies from the core image of the generating release", () => {
    // A preview names its own build of the core in EGRESS_PROXY_IMAGE.
    expect(proxyImageOf("dev")).toBe("${EGRESS_PROXY_IMAGE:-family-agenda:local}");
    expect(proxyImageOf("0.3.1")).toBe("ghcr.io/artkoenig/family-agenda:${FAMILY_AGENDA_VERSION:-0.3.1}");
    expect(proxyImageOf("main-1a2b3c4")).toBe("ghcr.io/artkoenig/family-agenda:${FAMILY_AGENDA_VERSION:-main}");
    const result = generatePluginsCompose("plugins:\n  - id: a\n    image: a:1\n", null, password, "0.3.1");
    expect(result.ok && result.compose).toContain("image: ghcr.io/artkoenig/family-agenda:${FAMILY_AGENDA_VERSION:-0.3.1}");
  });

  it("runs a bare companion with nothing but its image", () => {
    const { compose } = generated("plugins:\n  - id: a\n    image: a:1\n    companions: [{ name: b, image: b:1 }]\n");

    expect(compose.services["plugin-a-b"]).toEqual({ image: "b:1", restart: "unless-stopped", networks: ["plugin-a"] });
    expect(compose.services["plugin-a-b-egress"]).toBeUndefined();
  });

  it("adds a password to .env for each new database and the ticket key, and keeps those already there", () => {
    const secrets = ["PLUGIN_MATRIX_SYNAPSE_DATABASE_PASSWORD", "EGRESS_TICKET_KEY"];
    const lines = secrets.map((variable) => `${variable}=secret\n`).join("");
    expect(generated(matrix).dotEnv).toBe(lines);
    expect(generated(matrix, "PORT=8080").dotEnv).toBe(`PORT=8080\n${lines}`);
    expect(generated(matrix, secrets.map((variable) => `${variable}=old\n`).join("")).dotEnv).toBeNull();
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
    ["an egress proxy and a companion", "plugins:\n  - id: a\n    image: a:1\n    companions: [{ name: egress, image: b:1 }]\n", "companion egress of plugin a and plugin a both make the service plugin-a-egress"],
    ["volumes of two plugins", "plugins:\n  - id: a\n    image: a:1\n    companions: [{ name: c, image: c:1, volumes: { b-data: /d } }]\n  - id: a-b\n    image: a:1\n    companions: [{ name: c, image: c:1, volumes: { data: /d } }]\n", "plugin a-b and plugin a both make the volume plugin-a-b-data"],
    ["a plugin volume and a companion volume of another plugin", "plugins:\n  - id: a\n    image: a:1\n    volumes: { b-data: /d }\n  - id: a-b\n    image: a:1\n    companions: [{ name: c, image: c:1, volumes: { data: /d } }]\n", "plugin a-b and plugin a both make the volume plugin-a-b-data"],
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

describe("the default plugins.yml", () => {
  it("generates the plugins that come with the app", () => {
    const yml = readFileSync(new URL("../../../../plugins.yml", import.meta.url), "utf8");

    const { compose } = generated(yml);

    expect(Object.keys(compose.services)).toEqual(expect.arrayContaining(["plugin-ics", "plugin-imap", "plugin-webuntis"]));
    expect(compose.services["plugin-matrix"]).toBeUndefined();
  });

  it("generates Matrix, which is opt-in, once its block is uncommented", () => {
    const yml = readFileSync(new URL("../../../../plugins.yml", import.meta.url), "utf8");
    const uncommented = yml.replaceAll(/^ {2}# (?=[ -])/gm, "  ");

    const { compose } = generated(uncommented);

    expect(compose.services["plugin-matrix-synapse"]?.entrypoint).toEqual(["sh", "-c", expect.stringContaining("exec sh /config/start.sh")]);
    expect(compose.services["plugin-matrix-whatsapp"]).toBeDefined();
  });
});
