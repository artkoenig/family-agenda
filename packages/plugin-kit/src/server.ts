import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { contractVersion, endpoints, limits, type Description, type Endpoint, type PluginError as ErrorBody } from "@family-agenda/plugin-contract";
import { PluginError, type EndpointName, type PluginImplementation } from "./index";

/** A plugin as a function from request to response, served over HTTP or called in-process. */
export type PluginHandler = (request: Request) => Promise<Response>;

/** The full description of a plugin: what it states, and what the kit derives from it. */
export function describePlugin(plugin: PluginImplementation): Description {
  return {
    ...plugin.description,
    contractVersion,
    endpoints: { sourceAdded: plugin.sourceAdded !== undefined, sourceRemoved: plugin.sourceRemoved !== undefined, sourceAttributes: plugin.sourceAttributes !== undefined },
  };
}

const error = (status: number, kind: ErrorBody["kind"], message: string): Response => Response.json({ kind, message }, { status });

type Route = { name: EndpointName; endpoint: Endpoint };

function route(method: string, pathname: string): Route | undefined {
  const all = Object.entries(endpoints) as [EndpointName, Endpoint][];
  const found = all.find(([, endpoint]) => endpoint.path === pathname && endpoint.method.toUpperCase() === method);
  return found && { name: found[0], endpoint: found[1] };
}

type EndpointFunction = (request: unknown) => unknown;

function implementation(plugin: PluginImplementation, name: EndpointName): EndpointFunction | undefined {
  if (name === "description") return () => describePlugin(plugin);
  return plugin[name] as EndpointFunction | undefined;
}

type Body = { ok: true; value: unknown } | { ok: false; response: Response };

function parseJson(text: string): Body {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: error(400, "definite", "the request is no JSON") };
  }
}

async function bodyOf(request: Request, endpoint: Endpoint): Promise<Body> {
  if (endpoint.request === undefined) return { ok: true, value: undefined };
  const text = await request.text();
  if (Buffer.byteLength(text) > limits.maxPayloadBytes) return { ok: false, response: error(413, "definite", "the request is too large") };
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const result = endpoint.request.safeParse(parsed.value);
  return result.success ? { ok: true, value: result.data } : { ok: false, response: error(400, "definite", `invalid request: ${result.error.message}`) };
}

function errorAnswerTo(thrown: unknown): Response {
  if (thrown instanceof PluginError) return error(thrown.kind === "definite" ? 422 : 503, thrown.kind, thrown.message);
  return error(500, "temporary", thrown instanceof Error ? thrown.message : String(thrown));
}

function checkedResponse(endpoint: Endpoint, value: unknown): Response {
  if (endpoint.response === undefined) return new Response(null, { status: 204 });
  const result = endpoint.response.safeParse(value);
  return result.success ? Response.json(result.data) : error(500, "temporary", `the plugin answered invalidly: ${result.error.message}`);
}

async function answerEndpoint(found: Route, run: EndpointFunction, request: Request): Promise<Response> {
  const body = await bodyOf(request, found.endpoint);
  if (!body.ok) return body.response;
  try {
    return checkedResponse(found.endpoint, await run(body.value));
  } catch (thrown) {
    return errorAnswerTo(thrown);
  }
}

/**
 * Serves a plugin against the contract: routes each endpoint to its function, refuses an invalid
 * request with a definite error, and never answers with an invalid response.
 */
export function createPluginHandler(plugin: PluginImplementation): PluginHandler {
  return async (request) => {
    const { pathname } = new URL(request.url);
    const found = route(request.method, pathname);
    const run = found && implementation(plugin, found.name);
    if (!found || !run) return error(404, "definite", `no endpoint ${request.method} ${pathname}`);
    return answerEndpoint(found, run, request);
  };
}

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const method = incoming.method ?? "GET";
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") init.body = Buffer.concat(chunks);
  return new Request(`http://plugin${incoming.url ?? "/"}`, init);
}

/** Answers a temporary error when reading the request or writing the response failed, or drops a half-sent answer. */
export function answerUnexpectedFailure(outgoing: ServerResponse, thrown: unknown): void {
  if (outgoing.headersSent) {
    outgoing.destroy();
    return;
  }
  outgoing.writeHead(500, { "content-type": "application/json" });
  outgoing.end(JSON.stringify({ kind: "temporary", message: thrown instanceof Error ? thrown.message : String(thrown) }));
}

/** Serves a plugin over HTTP on `port` (0, the default, picks a free one); resolves once it listens. */
export async function servePlugin(plugin: PluginImplementation, options: { port?: number; host?: string } = {}): Promise<Server> {
  const handle = createPluginHandler(plugin);
  const server = createServer((incoming, outgoing) => {
    void toRequest(incoming)
      .then(handle)
      .then(async (response) => {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      })
      .catch((thrown: unknown) => {
        answerUnexpectedFailure(outgoing, thrown);
      });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? "0.0.0.0", resolve));
  return server;
}
