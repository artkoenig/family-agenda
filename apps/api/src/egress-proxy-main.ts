import { createEgressProxy } from "./egress/proxy";

// The egress proxy of one plugin container, which compose.plugins.yaml runs from the core image.
const allowlistUrl = process.env.EGRESS_ALLOWLIST_URL;
if (!allowlistUrl) throw new Error("EGRESS_ALLOWLIST_URL is not set");
const port = Number(process.env.PORT ?? 3128);

async function fetchAllowlist(): Promise<string[]> {
  const response = await fetch(allowlistUrl as string, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`the core answered ${response.status}`);
  const body = (await response.json()) as { hosts?: unknown };
  if (!Array.isArray(body.hosts) || !body.hosts.every((host) => typeof host === "string")) throw new Error("the core sent no list of hosts");
  return body.hosts;
}

const server = createEgressProxy(fetchAllowlist, (line) => {
  console.log(line);
}).listen(port, () => {
  console.log(`Egress proxy listening on port ${port}, allowing what ${allowlistUrl} lists`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
