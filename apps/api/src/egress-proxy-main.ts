import { proxySettingsOf, staticAllowlist, ticketAllowlist } from "./egress/proxy-allowlist";
import { createEgressProxy } from "./egress/proxy";

// The egress proxy of one plugin container, which compose.plugins.yaml runs from the core image.
const { port, allowlist } = proxySettingsOf(process.env);
const log = (line: string) => {
  console.log(line);
};
const declared = allowlist.hosts.join(", ") || "no declared hosts";
const server = createEgressProxy({ allowlist: "service" in allowlist ? ticketAllowlist(allowlist) : staticAllowlist(allowlist.hosts), log }).listen(port, () => {
  console.log(`Egress proxy listening on port ${port}, allowing ${"service" in allowlist ? `${declared} and the hosts of each ticket for ${allowlist.service}` : declared}`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
