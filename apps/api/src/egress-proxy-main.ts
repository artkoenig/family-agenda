import { allowlistFetcher, proxySettingsOf } from "./egress/allowlist-client";
import { createEgressProxy } from "./egress/proxy";

// The egress proxy of one plugin container, which compose.plugins.yaml runs from the core image.
const { url, token, port } = proxySettingsOf(process.env);
const log = (line: string) => {
  console.log(line);
};
const server = createEgressProxy({ allowlist: allowlistFetcher(url, token), log }).listen(port, () => {
  console.log(`Egress proxy listening on port ${port}, allowing what ${url} lists`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
