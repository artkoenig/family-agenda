import type { InstalledSourceType, LoadedSourceType, SourceTypeRegistry } from "@family-agenda/application";
import type { SourceTypeId } from "@family-agenda/domain";
import { loadProblem, type Description } from "@family-agenda/plugin-contract";
import type { PluginBinding } from "./bindings";
import { loadedSourceType } from "./translation";
import { callPlugin, type PluginContainerOptions } from "./transport";

type State = {
  /** The last description the plugin gave; null before it gave one. */
  description: Description | null;
  /** Why the description keeps the core from loading the plugin, such as another Source Type id. */
  problem: string | null;
  /** Why the plugin did not answer the last time it was asked; null if it did. */
  unreachable: string | null;
};

const initialState: State = { description: null, problem: null, unreachable: null };

/** How long a description a plugin gave is used before it is asked again. */
const defaultDescriptionMaxAgeMs = 10_000;

/**
 * The Source Types whose plugins run in containers (ADR-0001), bound to their URLs by `PLUGIN_URLS`.
 * The core asks each for its description when it loads it, at most every few seconds, so that one
 * page, which loads a Source Type once per Source, does not ask the plugin again each time: a plugin
 * is loadable while it describes the Source Type it is bound to, built for a plugin contract the core
 * implements.
 */
export class PluginContainers implements SourceTypeRegistry {
  private readonly states = new Map<SourceTypeId, State>();
  /** The description asked for last, while it is fresh or still on its way. */
  private readonly asked = new Map<SourceTypeId, { at: number; state: Promise<State> }>();

  private constructor(
    private readonly bindings: PluginBinding[],
    private readonly options: PluginContainerOptions,
  ) {}

  /** Asks every bound plugin for its description, so that the Admin area has something to show. */
  static async connect(bindings: PluginBinding[], options: PluginContainerOptions = {}): Promise<PluginContainers> {
    const containers = new PluginContainers(bindings, options);
    await Promise.all(bindings.map((binding) => containers.fresh(binding)));
    return containers;
  }

  /**
   * The bound Source Types as their plugins last described themselves. `installed()` is synchronous
   * (the port is), so it serves the description of the last `connect` or `load` instead of fetching
   * it: every polling tick loads each enabled Source Type, which keeps it as fresh as ADR-0001 asks.
   */
  installed(): InstalledSourceType[] {
    return this.bindings.map(({ sourceTypeId }) => {
      const { description, problem, unreachable } = this.states.get(sourceTypeId) ?? initialState;
      return {
        id: sourceTypeId,
        displayName: description?.displayName ?? sourceTypeId,
        description: description?.description ?? "",
        version: description?.version ?? "",
        needsLlm: description?.needsLlm ?? false,
        riskNotice: description?.riskNotice ?? null,
        notLoadable: problem ?? (description === null ? "the plugin has not described itself yet" : null),
        notReachable: unreachable,
      };
    });
  }

  async load(id: SourceTypeId): Promise<{ ok: true; sourceType: LoadedSourceType } | { ok: false }> {
    const binding = this.bindings.find((candidate) => candidate.sourceTypeId === id);
    if (!binding) return { ok: false };
    const { description, problem } = await this.fresh(binding);
    if (description === null || problem !== null) return { ok: false };
    return { ok: true, sourceType: loadedSourceType(description, (name, body) => callPlugin(binding.url, name, body, this.options)) };
  }

  /** The plugin's description, asked for again once the last one is older than the maximum age. */
  private fresh(binding: PluginBinding): Promise<State> {
    const maxAgeMs = this.options.descriptionMaxAgeMs ?? defaultDescriptionMaxAgeMs;
    const last = this.asked.get(binding.sourceTypeId);
    if (last && Date.now() - last.at < maxAgeMs) return last.state;
    const state = this.describe(binding);
    this.asked.set(binding.sourceTypeId, { at: Date.now(), state });
    return state;
  }

  /** Asks the plugin for its description and checks it; one that fails temporarily keeps the last it gave. */
  private async describe(binding: PluginBinding): Promise<State> {
    const previous = this.states.get(binding.sourceTypeId) ?? initialState;
    const answer = await callPlugin(binding.url, "description", undefined, this.options);
    let state: State;
    if (answer.ok) {
      state = { description: answer.body, problem: descriptionProblem(binding, answer.body), unreachable: null };
    } else if (answer.kind === "temporary") {
      state = { ...previous, unreachable: answer.unreachable ? answer.message : null };
    } else {
      state = { description: null, problem: answer.message, unreachable: null };
    }
    this.states.set(binding.sourceTypeId, state);
    return state;
  }
}

/** Why the core does not load a plugin that describes itself so, or null where it does. */
export function descriptionProblem(binding: PluginBinding, description: Description): string | null {
  if (description.sourceTypeId !== binding.sourceTypeId) {
    return `the plugin at ${binding.url} is for Source Type "${description.sourceTypeId}", but it is bound to "${binding.sourceTypeId}"`;
  }
  return loadProblem(description.contractVersion);
}
