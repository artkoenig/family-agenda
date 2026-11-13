import { proxySettingsOf, staticAllowlist, ticketAllowlist } from "./egress/allowlist-client";
import { createEgressProxy } from "./egress/proxy";

// The egress proxy of one plugin container, which compose.plugins.yaml runs from the core image.
const { port, allowlist } = proxySettingsOf(process.env);
const log = (line: string) => {
  console.log(line);
};
const server = createEgressProxy({ allowlist: "hosts" in allowlist ? staticAllowlist(allowlist.hosts) : ticketAllowlist(allowlist), log }).listen(port, () => {
  console.log(`Egress proxy listening on port ${port}, allowing ${"hosts" in allowlist ? allowlist.hosts.join(", ") : `what ${allowlist.url} lists for each call's ticket`}`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
