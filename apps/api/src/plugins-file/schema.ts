import { z } from "zod";

const name = z.string().regex(/^[a-z][a-z0-9-]*$/, "takes lowercase letters, digits and dashes, starting with a letter");

/** The tag of an image reference such as `ghcr.io:5000/org/image:1.2.3`; null for none. */
function tagOf(image: string): string | null {
  const lastPart = image.slice(image.lastIndexOf("/") + 1);
  const colon = lastPart.indexOf(":");
  return colon === -1 ? null : lastPart.slice(colon + 1);
}

/** Pinned: a digest, or a tag other than `latest`. */
export function isPinned(image: string): boolean {
  if (image.includes("@sha256:")) return true;
  const tag = tagOf(image);
  return tag !== null && tag !== "" && tag !== "latest";
}

const image = z
  .string()
  .regex(/^\S+$/, "is an image reference without spaces")
  .refine(isPinned, "must be pinned to a tag other than latest or to a digest, such as ghcr.io/org/plugin:1.2.0");

const egressHost = z
  .string()
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*:\d{1,5}$/,
    "takes host:port, such as api.example.com:443 or *.example.com:443",
  );

const egress = z.array(egressHost).default([]);

const companion = z
  .object({
    name,
    image,
    env: z.record(z.string(), z.string()).default({}),
    /** Logical volume name → path in the container. */
    volumes: z.record(name, z.string().startsWith("/", "is an absolute path")).default({}),
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
    limits: z
      .object({
        memory: z.string().regex(/^\d+[bkmg]$/, "takes a size such as 512m or 1g").default("512m"),
        cpus: z.number().positive().default(1),
      })
      .strict()
      .default({ memory: "512m", cpus: 1 }),
    companions: z.array(companion).default([]),
  })
  .strict()
  .refine((value) => unique(value.companions.map((each) => each.name)), { message: "names a companion twice", path: ["companions"] });

/** `plugins.yml`: the plugin containers the operator runs (ADR-0001). Not versioned. */
export const pluginsFileSchema = z
  .object({ plugins: z.array(plugin).default([]) })
  .strict()
  .refine((value) => unique(value.plugins.map((each) => each.id)), { message: "lists a plugin id twice", path: ["plugins"] });

export type PluginsFile = z.output<typeof pluginsFileSchema>;
export type Plugin = PluginsFile["plugins"][number];
export type Companion = Plugin["companions"][number];

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

/** The JSON schema of `plugins.yml`, for editors and readers. */
export function pluginsFileJsonSchema(): unknown {
  return z.toJSONSchema(pluginsFileSchema, { io: "input" });
}
