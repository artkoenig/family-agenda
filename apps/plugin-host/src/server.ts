import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authorizationHeader, decode, encode, isCallName, type CallName } from "@family-agenda/plugin-protocol";
import type { PluginManager } from "./manager";

/** Bundles and calls are bigger than this only by mistake. */
const maxBody = 32 * 1024 * 1024;

/**
 * The internal channel the core reaches the manager on, authenticated by a shared token:
 * `PUT /plugins/<id>` installs a bundle and answers the plugin's description, and
 * `POST /plugins/<id>/<call>` calls it with encoded arguments and answers the encoded outcome; 404
 * when no plugin is installed under the id.
 */
export function createPluginHostServer(manager: PluginManager, token: string): Server {
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer((request, response) => {
    handle(manager, expected, request, response).catch((error: unknown) => {
      console.error("The Plugin Host failed to answer a request:", error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
}

async function handle(manager: PluginManager, expected: Buffer, request: IncomingMessage, response: ServerResponse): Promise<void> {
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
  const body = await bodyOf(request);
  if (body === null) response.writeHead(413).end();
  else await answer(manager, route, body, response);
}

type Route = { kind: "install"; id: string } | { kind: "call"; id: string; call: CallName };

function routeOf(request: IncomingMessage): Route | null {
  const path = pathOf(request.url ?? "");
  if (!path) return null;
  if (path.call === undefined) return request.method === "PUT" ? { kind: "install", id: path.id } : null;
  return request.method === "POST" && isCallName(path.call) ? { kind: "call", id: path.id, call: path.call } : null;
}

/** `/plugins/<id>` or `/plugins/<id>/<call>`. */
function pathOf(url: string): { id: string; call: string | undefined } | null {
  const [, root, id, call, ...rest] = url.split("/");
  return root === "plugins" && id && rest.length === 0 ? { id, call } : null;
}

async function answer(manager: PluginManager, route: Route, body: string, response: ServerResponse): Promise<void> {
  if (route.kind === "install") {
    const installed = await manager.install(route.id, body);
    send(response, installed.ok ? 200 : 422, installed);
    return;
  }
  const outcome = await manager.call(route.id, route.call, decode(body) as unknown[]);
  if (outcome === null) response.writeHead(404).end();
  else send(response, 200, outcome);
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(encode(value));
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
