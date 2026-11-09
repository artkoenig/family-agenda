import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Where the JSON schema of `plugins.yml` is kept (`pnpm plugins-schema`). */
export const pluginsSchemaFile = fileURLToPath(new URL("../../../../plugins.schema.json", import.meta.url));

const name = z.string().regex(/^[a-z][a-z0-9-]*$/, "takes lowercase letters, digits and dashes, starting with a letter");

/** Pinned: a sha256 digest, or a tag other than `latest`. */
const pinnedImage = /^(\S+@sha256:[a-f0-9]{64}|[^\s@]*[^\s@/:]:(?!latest$)\w[\w.-]{0,127})$/;

export function isPinned(image: string): boolean {
  return pinnedImage.test(image);
}

const image = z.string().regex(pinnedImage, "must be pinned to a tag other than latest or to a sha256 digest, such as ghcr.io/org/plugin:1.2.0");

const egressHost = z
  .string()
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*:\d{1,5}$/,
    "takes host:port, such as api.example.com:443 or *.example.com:443",
  );

const egress = z.array(egressHost).default([]);

/** Logical volume name → path in the container; a name is one volume, shared by the plugin and its companions. */
const volumes = z.record(name, z.string().regex(/^\//, "is an absolute path")).default({});

const companion = z
  .object({
    name,
    image,
    env: z.record(z.string(), z.string()).default({}),
    volumes,
    command: z.union([z.string(), z.array(z.string())]).optional(),
    egress,
    database: z.boolean().default(false),
    /** Passed through to compose unchanged. */
    healthcheck: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const plugin = z
  .object({
    /** The Source Type id the plugin reports at `/description`. */
    id: name,
    image,
    egress,
    /** Such as configuration the plugin writes for its companions. */
    volumes,
    limits: z
      .object({
        memory: z.string().regex(/^\d+[bkmg]$/, "takes a size such as 512m or 1g").default("512m"),
        cpus: z.number().positive().default(1),
      })
      .strict()
      .default({ memory: "512m", cpus: 1 }),
    companions: z.array(companion).default([]),
  })
  .strict();

/** `plugins.yml`: the plugin containers the operator runs (ADR-0001). Not versioned. */
export const pluginsFileSchema = z.object({ plugins: z.array(plugin).default([]) }).strict();

export type PluginsFile = z.output<typeof pluginsFileSchema>;
export type Plugin = PluginsFile["plugins"][number];
export type Companion = Plugin["companions"][number];

/** The JSON schema of `plugins.yml`, for editors and readers. */
export function pluginsFileJsonSchema(): unknown {
  return z.toJSONSchema(pluginsFileSchema, { io: "input" });
}
