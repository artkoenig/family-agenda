import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authorizationHeader, decode, encode, isCallName, type AvailablePlugin, type CallName } from "@family-agenda/plugin-protocol";
import type { PluginManager } from "./manager";

/** Calls are bigger than this only by mistake. */
const maxBody = 32 * 1024 * 1024;

/**
 * The internal channel the core reaches the manager on, authenticated by a shared token:
 * `GET /plugins` lists the plugins installed from the Plugin Repository, and
 * `POST /plugins/<id>/<call>` calls one with encoded arguments and answers the encoded outcome; 404
 * when no plugin is installed under the id. The core never sends code.
 */
export function createPluginHostServer(manager: PluginManager, token: string, available: () => AvailablePlugin[]): Server {
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer((request, response) => {
    handle({ manager, available }, expected, request, response).catch((error: unknown) => {
      console.error("The Plugin Host failed to answer a request:", error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
}

type Host = { manager: PluginManager; available: () => AvailablePlugin[] };

async function handle(host: Host, expected: Buffer, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const given = Buffer.from(request.headers[authorizationHeader] ?? "");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    response.writeHead(401).end();
    return;
  }
  const route = routeOf(request);
  if (!route) {
    response.writeHead(404).end();
    return;
  }
  if (route.kind === "list") {
    send(response, host.available());
    return;
  }
  const body = await bodyOf(request);
  if (body === null) response.writeHead(413).end();
  else await answer(host.manager, route, body, response);
}

type Route = { kind: "list" } | { kind: "call"; id: string; call: CallName };

function routeOf(request: IncomingMessage): Route | null {
  const path = request.url ?? "";
  if (path === "/plugins") return request.method === "GET" ? { kind: "list" } : null;
  return request.method === "POST" ? callRouteOf(path) : null;
}

function callRouteOf(path: string): Route | null {
  const [, root, id = "", call = "", ...rest] = path.split("/");
  return root === "plugins" && id !== "" && rest.length === 0 && isCallName(call) ? { kind: "call", id, call } : null;
}

async function answer(manager: PluginManager, route: Extract<Route, { kind: "call" }>, body: string, response: ServerResponse): Promise<void> {
  // A core that stops waiting closes the request; the call's process is ended then.
  const gone = new AbortController();
  response.on("close", () => {
    if (!response.writableFinished) gone.abort();
  });
  const outcome = await manager.call(route.id, route.call, decode(body) as unknown[], gone.signal);
  if (outcome === null) response.writeHead(404).end();
  else send(response, outcome);
}

function send(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(encode(value));
}

async function bodyOf(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBody) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
