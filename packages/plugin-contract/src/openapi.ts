import { z } from "zod";
import { contractVersion, endpoints, errorSchema, limits } from "./index";

type Schema = Record<string, unknown>;
type Operation = { operationId: string; summary: string; requestBody?: Schema; responses: Record<string, Schema> };

export type OpenApiDocument = {
  openapi: "3.0.3";
  info: { title: string; version: string; description: string };
  paths: Record<string, Partial<Record<"get" | "post", Operation>>>;
  components: { schemas: Record<string, Schema> };
};

const json = (schema: Schema) => ({ content: { "application/json": { schema } } });

/** A reference to the component of a schema; every schema the contract names has a `meta` id. */
function ref(schema: z.ZodType): Schema {
  const id = z.globalRegistry.get(schema)?.id;
  if (id === undefined) throw new Error("Every request and response schema needs a meta id");
  return { $ref: `#/components/schemas/${id}` };
}

/** Every schema with a `meta` id, as an OpenAPI 3.0 component, by name. */
function components(): Record<string, Schema> {
  const generated = z.toJSONSchema(z.globalRegistry, { target: "openapi-3.0", uri: (id) => `#/components/schemas/${id}`, io: "output" });
  return Object.fromEntries(
    Object.entries(generated.schemas)
      .map(([id, schema]): [string, Schema] => {
        const rest: Schema = { ...schema };
        delete rest.$schema;
        delete rest.$id;
        return [id, rest];
      })
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function operation(name: string, endpoint: (typeof endpoints)[keyof typeof endpoints]): Operation {
  const request = "request" in endpoint ? endpoint.request : undefined;
  const response = "response" in endpoint ? endpoint.response : undefined;
  const error = json(ref(errorSchema));
  return {
    operationId: name,
    summary: `${endpoint.summary} Timeout ${endpoint.timeoutMs / 1000} s.`,
    ...(request === undefined ? {} : { requestBody: { required: true, ...json(ref(request)) } }),
    responses: {
      ...(response === undefined ? { "204": { description: "Done." } } : { "200": { description: "OK.", ...json(ref(response)) } }),
      "4XX": { description: "A definite error when kind is definite.", ...error },
      "5XX": { description: "A temporary error.", ...error },
    },
  };
}

/** The OpenAPI document of the contract, written to `openapi.json` by `pnpm openapi`. */
export function describeOpenApi(): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const [name, endpoint] of Object.entries(endpoints)) paths[endpoint.path] = { [endpoint.method]: operation(name, endpoint) };
  return {
    openapi: "3.0.3",
    info: {
      title: "Family Agenda plugin contract",
      version: contractVersion,
      description: `What a plugin container answers; the core calls, plugins never call the core (ADR-0001). Bodies are at most ${limits.maxPayloadBytes} bytes.`,
    },
    paths,
    components: { schemas: components() },
  };
}
