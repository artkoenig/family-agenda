/**
 * What a plugin written with the kit implements: one function per endpoint of the plugin contract
 * (ADR-0001). The kit is optional; the contract is the OpenAPI document of `plugin-contract`.
 */
import type { z } from "zod";
import type { Description, endpoints } from "@family-agenda/plugin-contract";

export type EndpointName = keyof typeof endpoints;

type Spec<Name extends EndpointName> = (typeof endpoints)[Name];
type Input<Name extends EndpointName> = Spec<Name> extends { request: infer Schema extends z.ZodType } ? z.infer<Schema> : undefined;
type Output<Name extends EndpointName> = Spec<Name> extends { response: infer Schema extends z.ZodType } ? z.input<Schema> : undefined;

/** The function behind one endpoint: the validated request in, the response out. */
export type EndpointHandler<Name extends EndpointName> = (request: Input<Name>) => Output<Name> | Promise<Output<Name>>;

/**
 * A plugin: its description, without what the kit fills in (the contract version and which
 * optional endpoints it implements), and the endpoints it implements besides `description`.
 */
export type PluginImplementation = {
  description: Omit<Description, "contractVersion" | "endpoints">;
} & { [Name in Exclude<EndpointName, "description">]?: EndpointHandler<Name> };

/** Thrown by a handler to answer with an error: `definite` needs an Admin, `temporary` is retried. */
export class PluginError extends Error {
  constructor(
    readonly kind: "definite" | "temporary",
    message: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}
