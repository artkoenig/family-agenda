import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLimits, PluginManager } from "./manager";
import { MockPluginRepository } from "./mock-repository";
import { installFromRepository } from "./repository";
import { createPluginHostServer } from "./server";

/**
 * The Plugin Host: installs the plugins the Plugin Repository publishes and runs each in a process
 * of its own. It has no database, no master key and no blobs; the core reaches it with
 * PLUGIN_HOST_TOKEN and gets the list of plugins from it.
 */
const token = process.env.PLUGIN_HOST_TOKEN;
if (!token) {
  // Without a token, api and worker run every plugin themselves; ending cleanly keeps Compose from restarting it.
  console.log("PLUGIN_HOST_TOKEN is not set, so plugins run in api and worker. Set it to `openssl rand -hex 32` to isolate them here.");
  process.exit(0);
}
const port = Number(process.env.PORT ?? 4100);
const isRoot = process.getuid?.() === 0;

const manager = new PluginManager({
  workDirectory: process.env.PLUGIN_WORK_DIRECTORY ?? "/run/plugin-host",
  // As root, the manager gives every plugin a user of its own; otherwise they all run as its user.
  firstUserId: isRoot ? Number(process.env.PLUGIN_FIRST_USER_ID ?? 20_000) : null,
  memoryMb: Number(process.env.PLUGIN_MEMORY_MB ?? defaultLimits.memoryMb),
  openFiles: Number(process.env.PLUGIN_OPEN_FILES ?? defaultLimits.openFiles),
  callTimeoutMs: Number(process.env.PLUGIN_CALL_TIMEOUT_MS ?? defaultLimits.callTimeoutMs),
});
// The token stays with the manager: plugin processes start with an empty environment.
delete process.env.PLUGIN_HOST_TOKEN;

// Until there is a Plugin Repository, a mock one publishes packages of this workspace.
const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const published = (process.env.MOCK_PLUGIN_REPOSITORY ?? "packages/source-ics").split(",").map((path) => path.trim()).filter((path) => path !== "");
const repository = await MockPluginRepository.fromPackages(published.map((path) => resolve(workspace, path)));
const { available, failures } = await installFromRepository(manager, repository);
for (const failure of failures) console.warn(failure);
console.log(`Plugin Host installed ${available.map(({ manifest }) => manifest.identity.sourceTypeId).join(", ") || "no plugins"}.`);

const server = createPluginHostServer(manager, token, () => available);
server.listen(port, () => {
  console.log(`Plugin Host listening on ${port}`);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    manager.stop();
    server.close(() => process.exit(0));
  });
}
