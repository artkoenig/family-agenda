import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { allows } from "./allowlist";

/** Fetches what the proxy allows now; rejects when it cannot tell. */
export type AllowlistFetch = () => Promise<string[]>;

/**
 * An HTTP CONNECT proxy, the only way out of one plugin container (ADR-0001). It asks `allowlist`
 * on every connection and refuses it when the host is not in it, or when the allowlist cannot be
 * fetched: it fails closed. Any request other than CONNECT is refused.
 */
export function createEgressProxy(allowlist: AllowlistFetch, log: (line: string) => void = () => {}): Server {
  const server = createServer((_request, response) => {
    response.writeHead(405, { "content-type": "text/plain" }).end("Only CONNECT is supported.\n");
  });
  server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    void tunnel(request, client, head, allowlist, log);
  });
  return server;
}

async function tunnel(request: IncomingMessage, client: Socket, head: Buffer, allowlist: AllowlistFetch, log: (line: string) => void) {
  client.on("error", () => client.destroy());
  const target = targetOf(request.url ?? "");
  const logRefusal = (why: string) => {
    log(`Refused ${request.url}: ${why}`);
  };
  const refusal = target === null ? "400 Bad Request" : await refusalOf(target, allowlist, logRefusal);
  if (target === null || refusal !== null) {
    refuse(client, refusal ?? "400 Bad Request");
    return;
  }
  const upstream = connect(target.port, target.host, () => {
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

/** The status refusing a connection to `target`, or null to let it through. */
async function refusalOf(target: { host: string; port: number }, allowlist: AllowlistFetch, log: (why: string) => void): Promise<string | null> {
  let allowed: string[];
  try {
    allowed = await allowlist();
  } catch (error) {
    log(`no allowlist (${error instanceof Error ? error.message : String(error)})`);
    return "503 Service Unavailable";
  }
  if (allows(allowed, target.host, target.port)) return null;
  log("not allowed");
  return "403 Forbidden";
}

function refuse(client: Socket, status: string): void {
  client.end(`HTTP/1.1 ${status}\r\n\r\n`);
}

/** `host:port` of a CONNECT request, such as `example.org:443` or `[::1]:443`; null if it is none. */
export function targetOf(authority: string): { host: string; port: number } | null {
  const match = /^\[?([^[\]]+?)\]?:(\d{1,5})$/.exec(authority);
  if (match === null) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return null;
  return { host: match[1] ?? "", port };
}
