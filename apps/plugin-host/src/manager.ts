import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, chown, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallFailure, CallOutcome, PluginDescription } from "@family-agenda/plugin-protocol";

export type ManagerOptions = {
  /** Where each plugin gets a directory of its own; nobody but the manager can list it. */
  workDirectory: string;
  /** The first of the user ids the plugins run as, one each; null to run them as the manager's user. */
  firstUserId: number | null;
  /** The heap a plugin process may use, in MiB. */
  memoryMb: number;
  /** How many files a plugin process may hold open. */
  openFiles: number;
  /** How long a call may take before its process is ended. */
  callTimeoutMs: number;
};

export const defaultLimits = { memoryMb: 256, openFiles: 256, callTimeoutMs: 120_000 } as const;

// Real paths: the permission model compares them, and Node resolves modules by them.
const runner = realpathSync(fileURLToPath(new URL("./plugin-process.mts", import.meta.url)));

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: { name: string; kind: unknown; message: string } };

type Installed = {
  hash: string;
  directory: string;
  userId: number | null;
  description: PluginDescription;
  /** The processes of the calls still running. */
  calls: Set<ChildProcess>;
};

/**
 * Runs each call of a plugin installed from a bundle in a Node process of its own, started for the
 * call and ended after it, so calls share no state and one failing leaves the others alone. The
 * process has the plugin's own user, its own
 * directory and temp space, an empty environment, the permission model allowing it to read only
 * its directory and to write only its temp space, without child processes, workers or native
 * addons, and with limits on memory and open files. Calls run in parallel without a limit.
 */
export class PluginManager {
  private readonly plugins = new Map<string, Installed>();
  private nextSlot = 0;

  constructor(private readonly options: ManagerOptions) {}

  /** Installs a plugin's bundle, replacing another one of the same id; the same bundle again changes nothing. */
  async install(id: string, bundle: string): Promise<{ ok: true; description: PluginDescription } | { ok: false; failure: CallFailure }> {
    const hash = createHash("sha256").update(bundle).digest("hex");
    const current = this.plugins.get(id);
    if (current?.hash === hash) return { ok: true, description: current.description };

    const { directory, userId } = await this.writeSlot(bundle);
    const installed: Installed = { hash, directory, userId, description: undefined as unknown as PluginDescription, calls: new Set() };
    const described = await this.callIn(installed, "describe", []);
    if (!described.ok) return described;
    installed.description = described.value as PluginDescription;
    if (installed.description.identity.sourceTypeId !== id) {
      return { ok: false, failure: { sourceError: null, message: `The bundle is for Source Type "${installed.description.identity.sourceTypeId}", not "${id}".` } };
    }
    // The plugin installed before stays until its replacement described itself; its running calls finish.
    this.plugins.set(id, installed);
    return { ok: true, description: installed.description };
  }

  /** A directory of its own for the bundle, readable only by the plugin's user when there is one. */
  private async writeSlot(bundle: string): Promise<{ directory: string; userId: number | null }> {
    const slot = this.nextSlot++;
    await mkdir(this.options.workDirectory, { recursive: true, mode: 0o711 });
    const directory = join(await realpath(this.options.workDirectory), String(slot));
    const userId = this.options.firstUserId === null ? null : this.options.firstUserId + slot;
    await mkdir(join(directory, "tmp"), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "plugin.mjs"), bundle, { mode: 0o400 });
    if (userId !== null) {
      for (const path of [join(directory, "plugin.mjs"), join(directory, "tmp"), directory]) await chown(path, userId, userId);
    }
    await chmod(directory, 0o500);
    return { directory, userId };
  }

  /** Calls a plugin; null if none is installed under the id. */
  async call(id: string, name: string, args: unknown[]): Promise<CallOutcome | null> {
    const installed = this.plugins.get(id);
    if (!installed) return null;
    return this.callIn(installed, name, args);
  }

  /** Ends every running call. */
  stop(): void {
    for (const installed of this.plugins.values()) this.end(installed);
    this.plugins.clear();
  }

  /** Runs one call in a process started for it, and ends the process once the call is answered. */
  private async callIn(installed: Installed, name: string, args: unknown[]): Promise<CallOutcome> {
    const child = this.spawn(installed);
    installed.calls.add(child);
    const outcome = await new Promise<CallOutcome>((resolve) => {
      const timer = setTimeout(() => {
        resolve(failed("The plugin did not answer in time.", "temporary"));
      }, this.options.callTimeoutMs);
      const settle = (outcome: CallOutcome) => {
        clearTimeout(timer);
        resolve(outcome);
      };
      child.on("message", (message: Reply | { ready: true }) => {
        if ("ready" in message) child.send({ id: 0, call: name, args });
        else settle(message.ok ? { ok: true, value: message.value } : { ok: false, failure: failureFrom(message.error) });
      });
      child.on("exit", () => {
        settle(failed("The plugin process ended.", "temporary"));
      });
    });
    child.kill("SIGKILL");
    installed.calls.delete(child);
    return outcome;
  }

  private spawn(installed: Installed): ChildProcess {
    const { directory, userId } = installed;
    const temp = join(directory, "tmp");
    const nodeArgs = [
      "--permission",
      `--allow-fs-read=${directory}`,
      `--allow-fs-read=${runner}`,
      `--allow-fs-write=${temp}`,
      // Where Node restricts the network too, a plugin reaches its Source; elsewhere it always may.
      ...(process.allowedNodeEnvironmentFlags.has("--allow-net") ? ["--allow-net"] : []),
      `--max-old-space-size=${this.options.memoryMb}`,
      runner,
      join(directory, "plugin.mjs"),
    ];
    return spawn("/bin/sh", ["-c", 'ulimit -n "$0" && exec "$@"', String(this.options.openFiles), process.execPath, ...nodeArgs], {
      cwd: directory,
      env: { TMPDIR: temp },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
      ...(userId === null ? {} : { uid: userId, gid: userId }),
    });
  }

  /** Ends the processes of the plugin's running calls. */
  private end(installed: Installed): void {
    for (const child of installed.calls) child.kill("SIGKILL");
    installed.calls.clear();
  }
}

function failed(message: string, sourceError: CallFailure["sourceError"] = null): CallOutcome {
  return { ok: false, failure: { sourceError, message } };
}

function failureFrom(error: { name: string; kind: unknown; message: string }): CallFailure {
  const kind = error.kind === "definite" || error.kind === "temporary" ? error.kind : null;
  return { sourceError: error.name === "SourceError" ? kind : null, message: error.message };
}
