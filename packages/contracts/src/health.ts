import { z } from "zod";

/** `version` is the release the image was built from, such as `0.3.1`, `main-1a2b3c4` or `dev`. */
export const healthResponse = z.object({ status: z.literal("ok"), version: z.string() });

export type HealthResponse = z.infer<typeof healthResponse>;
