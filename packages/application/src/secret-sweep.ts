import type { Clock, LlmEndpointRepository, SecretRef, SecretStore, SourceRepository } from "./ports";

export type SecretSweepDeps = {
  clock: Clock;
  secrets: SecretStore;
  sources: SourceRepository;
  endpoints: LlmEndpointRepository;
};

/**
 * How long a secret no one refers to is kept: a secret is stored before the Source or LLM endpoint
 * that refers to it, so a younger one may still be on its way.
 */
export const unreferencedSecretGraceMs = 60 * 60 * 1000;

/**
 * Removes the secrets no Source and no LLM endpoint refers to, which a crash between storing one
 * and saving what refers to it, or between replacing one and removing it, leaves behind.
 */
export function createSecretSweep(deps: SecretSweepDeps) {
  const { clock, secrets, sources, endpoints } = deps;
  return {
    /** Returns how many secrets it removed. */
    async sweep(): Promise<number> {
      const referenced = new Set<SecretRef>((await sources.list()).flatMap((source) => Object.values(source.secrets)));
      const apiKey = (await endpoints.find())?.apiKey;
      if (apiKey) referenced.add(apiKey);
      const before = clock.now().getTime() - unreferencedSecretGraceMs;
      const unreferenced = (await secrets.list()).filter(
        (secret) => !referenced.has(secret.ref) && secret.storedAt.getTime() < before,
      );
      for (const secret of unreferenced) await secrets.remove(secret.ref);
      return unreferenced.length;
    },
  };
}

export type SecretSweep = ReturnType<typeof createSecretSweep>;
