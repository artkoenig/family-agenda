export type Config = {
  databaseUrl: string;
  port: number;
  trustProxy: boolean;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return {
    databaseUrl,
    port: Number(env.PORT ?? 3000),
    trustProxy: env.TRUST_PROXY === "true",
  };
}
