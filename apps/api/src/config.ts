import { versionOf } from "./version";

export type Config = {
  port: number;
  trustProxy: boolean;
  /** The address the Family reaches the Instance at, such as `http://192.168.1.10:8080`; null to use the one a request came by. */
  publicUrl: string | null;
  /** The release the image was built from, such as `0.3.1` or `main-1a2b3c4`; `dev` for a build from the working tree. */
  version: string;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    trustProxy: env.TRUST_PROXY === "true",
    publicUrl: publicUrlOf(env.PUBLIC_URL),
    version: versionOf(env),
  };
}

function publicUrlOf(value: string | undefined): string | null {
  if (!value) return null;
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error("PUBLIC_URL must be an http or https address, such as http://192.168.1.10:8080");
  }
  return new URL(value).origin;
}
