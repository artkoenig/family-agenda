import { defaultLimits, PluginManager } from "./manager";
import { createPluginHostServer } from "./server";

/**
 * The Plugin Host: runs Source plugins the core installs as bundles, each in a process of its own.
 * It has no database, no master key and no blobs; the core reaches it with PLUGIN_HOST_TOKEN.
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

const server = createPluginHostServer(manager, token);
server.listen(port, () => {
  console.log(`Plugin Host listening on ${port}`);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    manager.stop();
    server.close(() => process.exit(0));
  });
}
