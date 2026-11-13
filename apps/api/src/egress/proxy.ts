import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { allows, isHostName, isPort, parseEntry, type AllowEntry, type HostPort } from "./allowlist";
import { ticketOfProxyAuthorization } from "./ticket";

/**
 * Fetches what the proxy allows now for a connection with `ticket`, the one its client presented
 * (null for none); null when the ticket is refused, or missing where one is needed; rejects when it
 * cannot tell.
 */
export type AllowlistFetch = (ticket: string | null) => Promise<string[] | null>;

/** The addresses a host name resolves to. */
export type Resolve = (host: string) => Promise<string[]>;

export type EgressProxyOptions = {
  allowlist: AllowlistFetch;
  resolve?: Resolve;
  /** Whether the proxy may connect to an address; by default only to public ones. */
  isReachable?: (address: string) => boolean;
  log?: (line: string) => void;
};

const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, order: "verbatim" })).map((entry) => entry.address);

/**
 * Loopback, private (Docker's networks among them), link-local, ULA, multicast and unspecified ranges.
 * BlockList checks IPv4-mapped IPv6 addresses against the IPv4 ranges itself, so ::ffff:0:0/96 is
 * not listed: it would match every IPv4 address.
 */
const internal = new BlockList();
/* eslint-disable sonarjs/no-hardcoded-ip -- the ranges the proxy refuses to connect to */
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) internal.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) internal.addSubnet(network, prefix, "ipv6");
/* eslint-enable sonarjs/no-hardcoded-ip */

/** Whether `address` is a public IP address, outside every internal range. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !internal.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * An HTTP CONNECT proxy, the only way out of one plugin container (ADR-0001). It asks `allowlist`
 * on every connection, with the ticket the client presented as `Proxy-Authorization`, and answers
 * 407 when the ticket is refused, or missing where one is needed. It refuses the connection when the
 * host is not in the allowlist, or when the allowlist cannot be fetched: it fails closed. It resolves the host once and connects to that address, and only to a
 * public one, so neither an allowed name nor DNS rebinding reaches the Instance's own network;
 * names without a dot, such as compose services, it refuses outright. Any request other than
 * CONNECT is refused.
 */
export function createEgressProxy({ allowlist, resolve = systemResolve, isReachable = isPublicAddress, log = () => {} }: EgressProxyOptions): Server {
  const server = createServer((_request, response) => {
    response.writeHead(405, { "content-type": "text/plain" }).end("Only CONNECT is supported.\n");
  });
  server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    const ticket = ticketOfProxyAuthorization(request.headers["proxy-authorization"]);
    void decide(request.url ?? "", ticket, { allowlist, resolve, isReachable }).then((decision) => {
      if ("refusal" in decision) {
        log(`Refused ${request.url}: ${decision.why}`);
        refuse(client, decision.refusal);
      } else tunnel(client, head, decision.address, decision.port);
    });
  });
  return server;
}

type Decision = { address: string; port: number } | { refusal: string; why: string };

async function decide(authority: string, ticket: string | null, options: Required<Omit<EgressProxyOptions, "log">>): Promise<Decision> {
  const target = targetOf(authority);
  if (target === null) return { refusal: "400 Bad Request", why: "no host:port" };
  const refusal = await allowlistRefusal(target, ticket, options.allowlist);
  if (refusal !== null) return refusal;
  const addresses = await addressesOf(target.host, options.resolve);
  if (addresses.length === 0) return { refusal: "502 Bad Gateway", why: "does not resolve" };
  if (!addresses.every(options.isReachable)) return { refusal: "403 Forbidden", why: "an internal address" };
  return { address: addresses[0] ?? "", port: target.port };
}

/** Why the allowlist for `ticket` keeps the proxy from connecting to `target`; null where it allows it. */
async function allowlistRefusal(target: HostPort, ticket: string | null, allowlist: AllowlistFetch): Promise<Extract<Decision, { refusal: string }> | null> {
  const entries = await entriesOf(allowlist, ticket);
  if (entries === "unavailable") return { refusal: "503 Service Unavailable", why: "no allowlist" };
  if (entries === "refused") return { refusal: proxyAuthenticationRequired, why: ticket === null ? "no ticket" : "ticket refused" };
  return allows(entries, target) ? null : { refusal: "403 Forbidden", why: "not allowed" };
}

const proxyAuthenticationRequired = '407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="family-agenda"';

async function entriesOf(allowlist: AllowlistFetch, ticket: string | null): Promise<AllowEntry[] | "refused" | "unavailable"> {
  try {
    const hosts = await allowlist(ticket);
    return hosts === null ? "refused" : hosts.flatMap((text) => parseEntry(text) ?? []);
  } catch {
    return "unavailable";
  }
}

async function addressesOf(host: string, resolve: Resolve): Promise<string[]> {
  if (isIP(host) !== 0) return [host];
  try {
    return await resolve(host);
  } catch {
    return [];
  }
}

function tunnel(client: Socket, head: Buffer, address: string, port: number): void {
  const upstream = connect(port, address, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => {
    if (client.writable && upstream.bytesRead === 0 && upstream.bytesWritten === 0) refuse(client, "502 Bad Gateway");
    else client.destroy();
  });
  client.on("close", () => upstream.destroy());
}

function refuse(client: Socket, status: string): void {
  client.end(`HTTP/1.1 ${status}\r\n\r\n`);
}

/**
 * `host:port` of a CONNECT request, such as `example.org:443` or `[2001:db8::1]:443`; null if it
 * is none, or a name without a dot.
 */
export function targetOf(authority: string): HostPort | null {
  const match = /^(?:\[([0-9a-f:.]+)\]|([^[\]:]+)):(\d{1,5})$/i.exec(authority);
  const port = Number(match?.[3]);
  if (match === null || !isPort(port)) return null;
  const host = hostOf(match[1], match[2] ?? "");
  return host === null ? null : { host, port };
}

/** The host of a CONNECT target: an IPv6 literal in brackets, an IPv4 address, or a dotted name. */
function hostOf(bracketed: string | undefined, plain: string): string | null {
  if (bracketed !== undefined) return isIP(bracketed) === 6 ? bracketed.toLowerCase() : null;
  const host = plain.toLowerCase();
  return isIP(host) === 4 || (host.includes(".") && isHostName(host)) ? host : null;
}
