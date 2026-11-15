import { proxySettingsOf } from "./egress/proxy-allowlist";
import { createEgressProxy } from "./egress/proxy";

// The egress proxy of one plugin container, which compose.plugins.yaml runs from the core image.
const { port, allowlist, allowing } = proxySettingsOf(process.env);
const log = (line: string) => {
  console.log(line);
};
const server = createEgressProxy({ allowlist, log }).listen(port, () => {
  console.log(`Egress proxy listening on port ${port}, allowing ${allowing}`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
