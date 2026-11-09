import { endpoints, errorSchema, type Endpoint, type EndpointName, type EndpointResponse } from "@family-agenda/plugin-contract";

/** What a call to a plugin came to: its validated answer, or an error as the contract classifies it. */
export type CallResult<N extends EndpointName = EndpointName> =
  | { ok: true; body: EndpointResponse<N> }
  | { ok: false; kind: "definite" | "temporary"; message: string; unreachable: boolean };

type CallError = Extract<CallResult, { ok: false }>;

export type PluginContainerOptions = {
  /** Replaces the timeouts of the plugin contract, such as for a test of a plugin that does not answer. */
  timeoutsMs?: Partial<Record<EndpointName, number>>;
};

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Calls one endpoint of the plugin at `url`, validating the request and the answer against the
 * plugin contract. A 4xx with `definite` is a definite error; a 5xx, a timeout or no answer is a
 * temporary one, and so is a 4xx that does not say it is definite. Only a plugin that does not
 * answer at all is not reachable.
 */
export async function callPlugin<N extends EndpointName>(url: string, name: N, body: unknown, options: PluginContainerOptions = {}): Promise<CallResult<N>> {
  const endpoint: Endpoint = endpoints[name];
  const request = endpoint.request?.safeParse(body);
  if (request?.success === false) {
    return { ok: false, kind: "definite", message: `The core asked the plugin at ${url} for ${name} invalidly: ${request.error.message}`, unreachable: false };
  }
  const timeoutMs = options.timeoutsMs?.[name] ?? endpoint.timeoutMs;
  const response = await send(url, endpoint, body, timeoutMs);
  return response instanceof Response ? answerOf(url, name, endpoint, response) : response;
}

async function send(url: string, endpoint: Endpoint, body: unknown, timeoutMs: number): Promise<Response | CallError> {
  try {
    return await fetch(url + endpoint.path, {
      method: endpoint.method.toUpperCase(),
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      ...(endpoint.request === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const why = error instanceof Error && error.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : messageOf(error);
    return { ok: false, kind: "temporary", message: `The plugin at ${url} is not reachable: ${why}`, unreachable: true };
  }
}

async function answerOf<N extends EndpointName>(url: string, name: N, endpoint: Endpoint, response: Response): Promise<CallResult<N>> {
  const answer = await bodyOf(response);
  if (response.status >= 400) return errorOf(name, response.status, answer);
  if (endpoint.response === undefined) return { ok: true, body: undefined as EndpointResponse<N> };
  const parsed = endpoint.response.safeParse(answer);
  if (parsed.success) return { ok: true, body: parsed.data as EndpointResponse<N> };
  return { ok: false, kind: "definite", message: `The plugin at ${url} answered ${name} invalidly: ${parsed.error.message}`, unreachable: false };
}

function errorOf(name: EndpointName, status: number, answer: unknown): CallError {
  const error = errorSchema.safeParse(answer);
  const definite = status < 500 && error.success && error.data.kind === "definite";
  const message = error.success ? error.data.message : `${name} answered ${status}`;
  return { ok: false, kind: definite ? "definite" : "temporary", message, unreachable: false };
}
