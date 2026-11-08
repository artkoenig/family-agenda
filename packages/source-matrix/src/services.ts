import { spawn, type ChildProcess } from "node:child_process";
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import pg from "pg";
import type { Services } from "@family-agenda/source-sdk";
import { pathsOf, secretsOf, writeConfiguration, type MatrixLayout } from "./configuration";
import { messengers, type Messenger } from "./messengers";

/** The programs the image ships: Synapse's Python and one bridge per Messenger. */
export type MatrixPrograms = {
  /** The Python of Synapse's virtual environment. */
  synapse: string;
  /** By Messenger id, its bridge's executable. */
  bridges: Record<string, string>;
};

export const defaultPrograms = {
  synapse: "/opt/synapse/bin/python",
  bridges: { whatsapp: "/usr/local/bin/mautrix-whatsapp" },
} satisfies MatrixPrograms;

/** Whether the image has what a Messenger needs: Synapse and its bridge. */
export async function isInstalled(programs: MatrixPrograms, messenger: Messenger): Promise<boolean> {
  const bridge = programs.bridges[messenger.id];
  return bridge !== undefined && (await isExecutable(programs.synapse)) && (await isExecutable(bridge));
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type MatrixServicesOptions = MatrixLayout & {
  programs: MatrixPrograms;
  /** A Postgres URL allowed to create a role and a database, for Synapse's own. */
  databaseUrl: string;
  /** Replaces creating Synapse's role and database at `databaseUrl`, such as in tests without Postgres. */
  ensureDatabase?: (database: MatrixLayout["database"], password: string) => Promise<void>;
  log?: (line: string) => void;
};

/** What went wrong starting the services, kept beside the instance file for the `api` container. */
export function statusFileOf(instanceFile: string): string {
  return join(dirname(instanceFile), "status.json");
}

/** Why the services could not start, as the worker last wrote it; null if nothing is wrong. */
export async function readProblem(instanceFile: string): Promise<string | null> {
  try {
    const status = JSON.parse(await readFile(statusFileOf(instanceFile), "utf8")) as { problem?: unknown };
    return typeof status.problem === "string" ? status.problem : null;
  } catch {
    return null;
  }
}

/**
 * Runs Synapse while a Messenger is enabled, and the bridge of each enabled Messenger, as child
 * processes of the worker. Synapse gets a database of its own on the Instance's Postgres server,
 * created on its first start. A process that ends is started again, ever more slowly.
 */
function bridgesOf(options: MatrixServicesOptions, log: (line: string) => void): Map<string, Program> {
  const bridges = new Map<string, Program>();
  for (const messenger of messengers) {
    const command = options.programs.bridges[messenger.id];
    if (!command) continue;
    const directory = join(options.dataDirectory, messenger.id);
    bridges.set(
      messenger.id,
      new Program({
        name: `mautrix-${messenger.id}`,
        command,
        // Without saving the configuration back: it is written anew on every start.
        args: ["-c", join(directory, "config.yaml"), "-r", join(directory, "registration.yaml"), "-n"],
        cwd: directory,
        log,
      }),
    );
  }
  return bridges;
}

export function matrixServices(options: MatrixServicesOptions): Services {
  const log = options.log ?? ((line: string) => {
    console.log(line);
  });
  const createDatabase =
    options.ensureDatabase ?? ((database, password) => ensureDatabase(options.databaseUrl, database, password));
  const paths = pathsOf(options);
  const synapse = new Program({
    name: "synapse",
    command: options.programs.synapse,
    args: ["-m", "synapse.app.homeserver", "--config-path", paths.synapse.config],
    cwd: paths.synapse.directory,
    log,
  });
  const bridges = bridgesOf(options, log);
  let prepared = false;
  let problem: string | null | undefined;

  async function report(found: string | null): Promise<void> {
    if (found === problem) return;
    problem = found;
    await mkdir(dirname(options.instanceFile), { recursive: true });
    await writeFile(statusFileOf(options.instanceFile), `${JSON.stringify({ problem: found })}\n`);
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...bridges.values()].map((bridge) => bridge.stop()));
    await synapse.stop();
    prepared = false;
    if (problem) await report(null);
  }

  async function prepareIfNeeded(): Promise<void> {
    if (prepared) return;
    try {
      const secrets = await secretsOf(options);
      await createDatabase(options.database, secrets.databasePassword);
      await writeConfiguration(options, secrets);
    } catch (error) {
      const message = `Matrix could not be set up: ${error instanceof Error ? error.message : String(error)}`;
      await report(message);
      throw new Error(message, { cause: error });
    }
    prepared = true;
  }

  async function startBridges(wanted: Messenger[]): Promise<void> {
    synapse.start();
    // The bridges start once Synapse answers, which takes a while the first time.
    if (!(await answers(`http://127.0.0.1:${options.ports.synapse}/health`))) {
      if (synapse.keepsFailing()) await report("Synapse keeps stopping; the worker's log says why.");
      return;
    }
    for (const [id, bridge] of bridges) {
      if (wanted.some((messenger) => messenger.id === id)) bridge.start();
      else await bridge.stop();
    }
    const failing = [...bridges.entries()].find(([, bridge]) => bridge.keepsFailing());
    await report(failing ? `The ${failing[0]} bridge keeps stopping; the worker's log says why.` : null);
  }

  return {
    async reconcile({ enabled, entries }) {
      const wanted: Messenger[] = [];
      for (const messenger of messengers) {
        if (enabled && entries.includes(messenger.id) && (await isInstalled(options.programs, messenger))) wanted.push(messenger);
      }
      if (wanted.length === 0) {
        await stopAll();
        return;
      }
      await prepareIfNeeded();
      await startBridges(wanted);
    },

    stop: stopAll,
  };
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/**
 * Creates Synapse's role and database, with the C collation Synapse needs, unless they exist,
 * and gives the role the password kept in the data volume.
 */
export async function ensureDatabase(databaseUrl: string, database: MatrixLayout["database"], password: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const role = client.escapeIdentifier(database.user);
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [database.user]);
    await client.query(`${exists.rowCount ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD ${client.escapeLiteral(password)}`);
    const created = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database.name]);
    if (!created.rowCount) {
      await client.query(
        `CREATE DATABASE ${client.escapeIdentifier(database.name)} OWNER ${role} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
      );
    }
  } finally {
    await client.end();
  }
}

/** How long a program has to run before it counts as started well, and its failures are forgotten. */
const stableMs = 5 * 60_000;

/** How long a program may take to stop before it is killed. */
const stopMs = 10_000;

/** A child process kept running while wanted: one that ends is started again, ever more slowly. */
export class Program {
  private child: ChildProcess | null = null;
  private restart: NodeJS.Timeout | null = null;
  private wanted = false;
  private startedAt = 0;
  /** How often in a row it ended soon after it started. */
  private failures = 0;

  constructor(private readonly spec: { name: string; command: string; args: string[]; cwd: string; log: (line: string) => void }) {}

  get running(): boolean {
    return this.child !== null;
  }

  /** Whether it ended soon after starting three times in a row, and has not run well since. */
  keepsFailing(): boolean {
    const runsWell = this.child !== null && Date.now() - this.startedAt > stableMs;
    return this.failures >= 3 && !runsWell;
  }

  start(): void {
    this.wanted = true;
    if (this.child || this.restart) return;
    this.spawn();
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.restart) clearTimeout(this.restart);
    this.restart = null;
    const { child } = this;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), stopMs);
      child.once("close", () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private spawn(): void {
    const { name, command, args, cwd, log } = this.spec;
    this.startedAt = Date.now();
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        log(`[${name}] ${line}`);
      });
    }
    let ended = false;
    const end = (why: string) => {
      if (ended) return;
      ended = true;
      this.child = null;
      if (!this.wanted) return;
      this.failures = Date.now() - this.startedAt > stableMs ? 1 : this.failures + 1;
      const delay = Math.min(60_000, 1000 * 2 ** (this.failures - 1));
      log(`[${name}] ${why}; starting it again in ${delay / 1000} s`);
      this.restart = setTimeout(() => {
        this.restart = null;
        if (this.wanted) this.spawn();
      }, delay);
      this.restart.unref();
    };
    child.on("error", (error) => {
      // A program that could not be started emits no exit.
      if (child.pid === undefined) end(`could not be started: ${error.message}`);
    });
    child.on("close", (code, signal) => {
      end(`ended with ${signal ?? `code ${code}`}`);
    });
  }
}
