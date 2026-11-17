import { isLocalHost } from "@family-agenda/domain";
import type { Clock, EndpointCheck, Extractor, LlmEndpoint, LlmEndpointRepository, SecretRef, SecretStore } from "./ports";

export type LlmEndpointDeps = {
  clock: Clock;
  endpoints: LlmEndpointRepository;
  secrets: SecretStore;
  extractor: Extractor;
  /** The endpoint the operator supplies for every Family, which replaces the Family's own; null for none. */
  supplied?: LlmEndpoint | null;
};

export type LlmEndpointSummary = {
  baseUrl: string;
  model: string;
  /** Whether an API key is stored; the key never leaves the SecretStore but to the endpoint. */
  hasApiKey: boolean;
  /** Whether it is on the home network, so that messages do not leave the house. */
  local: boolean;
};

/** What testing an endpoint being entered tells: its check, or that its URL is none. */
export type LlmEndpointTest = EndpointCheck | { ok: false; problem: "invalid-endpoint-url" };

export type LlmEndpointInput = {
  /** The base URL of an OpenAI-compatible server, such as `http://ollama:11434/v1`. */
  baseUrl: string;
  model: string;
  /** Left empty, the stored key stays. */
  apiKey: string;
  removeApiKey?: boolean;
  /** Needed to save an endpoint that is not on the home network. */
  thirdPartiesAcknowledged?: boolean;
};

export type SaveLlmEndpointResult =
  | { ok: true }
  | { ok: false; problem: "invalid-endpoint-url" | "invalid-model" | "third-parties-not-acknowledged" };

const maximumModelLength = 200;

export function createLlmEndpointAccess(deps: LlmEndpointDeps) {
  const { clock, endpoints, secrets } = deps;
  const supplied = deps.supplied ?? null;
  const endpointOf = () => familyEndpointOf({ endpoints, secrets, supplied });

  return {
    /** Whether the operator supplies the endpoint, which the Family can then neither see nor change. */
    supplied: supplied !== null,

    async current(): Promise<LlmEndpointSummary | null> {
      if (supplied) return summaryOf({ baseUrl: supplied.baseUrl, model: supplied.model, hasApiKey: supplied.apiKey !== null });
      const stored = await endpoints.find();
      if (!stored) return null;
      return summaryOf({ baseUrl: stored.baseUrl, model: stored.model, hasApiKey: stored.apiKey !== null });
    },

    /** Whether the Family's endpoint, supplied or saved, answers, with the models it offers; null if there is none. */
    async check(): Promise<EndpointCheck | null> {
      const endpoint = await endpointOf();
      return endpoint ? deps.extractor.check(endpoint) : null;
    },

    /**
     * Tests an endpoint the Admin is entering, before it is saved: whether it answers, with its
     * models. The stored API key goes only to the endpoint it was saved for.
     */
    async checkAt(input: { baseUrl: string; apiKey: string }): Promise<LlmEndpointTest> {
      const url = endpointUrl(input.baseUrl);
      if (!url) return { ok: false, problem: "invalid-endpoint-url" };
      const baseUrl = url.href.replace(/\/+$/, ""); // eslint-disable-line sonarjs/super-linear-regex -- single-char quantifier anchored at end is O(n)
      const typed = input.apiKey.trim();
      const saved = await llmEndpointOf({ endpoints, secrets });
      const apiKey = typed !== "" ? typed : saved?.baseUrl === baseUrl ? saved.apiKey : null;
      return deps.extractor.check({ baseUrl, model: "", apiKey });
    },

    /**
     * Saves the Family's one LLM endpoint. One that is not on the home network receives the text
     * of third parties' messages, such as teachers' mails, so saving it needs an acknowledgement.
     */
    async save(input: LlmEndpointInput): Promise<SaveLlmEndpointResult> {
      const validated = validateEndpoint(input);
      if ("problem" in validated) return validated;
      const { url } = validated;
      const local = isLocalHost(url.hostname);
      const stored = await endpoints.find();
      const apiKey = await resolveApiKey(input, stored, secrets);
      const now = clock.now();
      await endpoints.save({
        baseUrl: url.href.replace(/\/+$/, ""), // eslint-disable-line sonarjs/super-linear-regex -- single-char quantifier anchored at end is O(n)
        model: input.model.trim(),
        apiKey,
        acknowledgedAt: local ? null : now,
        savedAt: now,
      });
      const replacing = input.removeApiKey === true || input.apiKey.trim() !== "";
      if (replacing && stored?.apiKey) await secrets.remove(stored.apiKey);
      return { ok: true };
    },

    /** Switches the AI off: forgets the endpoint and its API key; messages then wait to be read. */
    async remove(): Promise<void> {
      const stored = await endpoints.find();
      if (!stored) return;
      await endpoints.remove();
      if (stored.apiKey) await secrets.remove(stored.apiKey);
    },
  };
}

export type LlmEndpointAccess = ReturnType<typeof createLlmEndpointAccess>;

/** What the Admin area shows of an endpoint: never its API key, only whether it has one. */
function summaryOf(endpoint: Omit<LlmEndpointSummary, "local">): LlmEndpointSummary {
  return { ...endpoint, local: isLocalHost(new URL(endpoint.baseUrl).hostname) };
}

/** The endpoint the Family extracts through: the one the operator supplies, else its own saved one. */
export async function familyEndpointOf(deps: {
  endpoints: LlmEndpointRepository;
  secrets: SecretStore;
  supplied: LlmEndpoint | null;
}): Promise<LlmEndpoint | null> {
  return deps.supplied ?? llmEndpointOf(deps);
}

/** The Family's LLM endpoint with its API key, or null if none is configured. */
export async function llmEndpointOf(deps: { endpoints: LlmEndpointRepository; secrets: SecretStore }): Promise<LlmEndpoint | null> {
  const stored = await deps.endpoints.find();
  if (!stored) return null;
  const apiKey = stored.apiKey ? await deps.secrets.get(stored.apiKey) : null;
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey };
}

/** An http or https URL without credentials, query or fragment, or null. */
function endpointUrl(text: string): URL | null {
  if (!URL.canParse(text.trim())) return null;
  const url = new URL(text.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  return url;
}

function validateEndpoint(input: LlmEndpointInput): { url: URL } | Extract<SaveLlmEndpointResult, { ok: false }> {
  const url = endpointUrl(input.baseUrl);
  if (!url) return { ok: false, problem: "invalid-endpoint-url" };
  const model = input.model.trim();
  if (model === "" || model.length > maximumModelLength) return { ok: false, problem: "invalid-model" };
  const local = isLocalHost(url.hostname);
  if (!local && input.thirdPartiesAcknowledged !== true) {
    return { ok: false, problem: "third-parties-not-acknowledged" };
  }
  return { url };
}

async function resolveApiKey(
  input: LlmEndpointInput,
  stored: { apiKey: SecretRef | null } | null,
  secrets: SecretStore,
): Promise<SecretRef | null> {
  const replacing = input.removeApiKey === true || input.apiKey.trim() !== "";
  if (!replacing) return stored?.apiKey ?? null;
  return input.apiKey.trim() !== "" ? await secrets.put(input.apiKey.trim()) : null;
}
