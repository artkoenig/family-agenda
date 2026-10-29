import { isLocalHost } from "@family-agenda/domain";
import type { Clock, LlmEndpoint, LlmEndpointRepository, SecretRef, SecretStore } from "./ports";

export type LlmEndpointDeps = {
  clock: Clock;
  endpoints: LlmEndpointRepository;
  secrets: SecretStore;
};

export type LlmEndpointSummary = {
  baseUrl: string;
  model: string;
  /** Whether an API key is stored; the key never leaves the SecretStore but to the endpoint. */
  hasApiKey: boolean;
  /** Whether it is on the home network, so that messages do not leave the house. */
  local: boolean;
  /** Whether its model reads images, such as scanned letters. */
  vision: boolean;
};

export type LlmEndpointInput = {
  /** The base URL of an OpenAI-compatible server, such as `http://ollama:11434/v1`. */
  baseUrl: string;
  model: string;
  /** Left empty, the stored key stays. */
  apiKey: string;
  removeApiKey?: boolean;
  /** Whether its model reads images; scanned pages go to OCR otherwise. */
  vision?: boolean;
  /** Needed to save an endpoint that is not on the home network. */
  thirdPartiesAcknowledged?: boolean;
};

export type SaveLlmEndpointResult =
  | { ok: true }
  | { ok: false; problem: "invalid-endpoint-url" | "invalid-model" | "third-parties-not-acknowledged" };

const maximumModelLength = 200;

export function createLlmEndpointAccess(deps: LlmEndpointDeps) {
  const { clock, endpoints, secrets } = deps;

  return {
    async current(): Promise<LlmEndpointSummary | null> {
      const stored = await endpoints.find();
      if (!stored) return null;
      return {
        baseUrl: stored.baseUrl,
        model: stored.model,
        hasApiKey: stored.apiKey !== null,
        local: isLocalHost(new URL(stored.baseUrl).hostname),
        vision: stored.vision,
      };
    },

    /**
     * Saves the Family's one LLM endpoint. One that is not on the home network receives the text
     * of third parties' messages, such as teachers' mails, so saving it needs an acknowledgement.
     */
    async save(input: LlmEndpointInput): Promise<SaveLlmEndpointResult> {
      const url = endpointUrl(input.baseUrl);
      if (!url) return { ok: false, problem: "invalid-endpoint-url" };
      const model = input.model.trim();
      if (model === "" || model.length > maximumModelLength) return { ok: false, problem: "invalid-model" };
      const local = isLocalHost(url.hostname);
      if (!local && input.thirdPartiesAcknowledged !== true) {
        return { ok: false, problem: "third-parties-not-acknowledged" };
      }

      const stored = await endpoints.find();
      const replacing = input.removeApiKey === true || input.apiKey.trim() !== "";
      let apiKey: SecretRef | null = stored?.apiKey ?? null;
      if (replacing) apiKey = input.apiKey.trim() !== "" ? await secrets.put(input.apiKey.trim()) : null;
      const now = clock.now();
      await endpoints.save({
        baseUrl: url.href.replace(/\/+$/, ""),
        model,
        apiKey,
        vision: input.vision === true,
        acknowledgedAt: local ? null : now,
        savedAt: now,
      });
      if (replacing && stored?.apiKey) await secrets.remove(stored.apiKey);
      return { ok: true };
    },
  };
}

export type LlmEndpointAccess = ReturnType<typeof createLlmEndpointAccess>;

/** The Family's LLM endpoint with its API key, or null if none is configured. */
export async function llmEndpointOf(deps: Omit<LlmEndpointDeps, "clock">): Promise<LlmEndpoint | null> {
  const stored = await deps.endpoints.find();
  if (!stored) return null;
  const apiKey = stored.apiKey ? await deps.secrets.get(stored.apiKey) : null;
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey, vision: stored.vision };
}

/** An http or https URL without credentials, query or fragment, or null. */
function endpointUrl(text: string): URL | null {
  if (!URL.canParse(text.trim())) return null;
  const url = new URL(text.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  return url;
}
