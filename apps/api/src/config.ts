export type Config = {
  databaseUrl: string;
  masterKeyFile: string;
  port: number;
  trustProxy: boolean;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return {
    databaseUrl,
    masterKeyFile: env.MASTER_KEY_FILE ?? "/var/lib/family-butler/master-key/master.key",
    port: Number(env.PORT ?? 3000),
    trustProxy: env.TRUST_PROXY === "true",
  };
}
