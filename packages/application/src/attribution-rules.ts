import { randomUUID } from "node:crypto";
import {
  parseAttributeValue,
  type Attribution,
  type AttributionRule,
  type AttributionRuleId,
  type MultilingualText,
  type SourceId,
  type SourceTypeId,
} from "@family-agenda/domain";
import type {
  AttributionRuleRepository,
  Clock,
  FamilyMemberRepository,
  FamilyRepository,
  KnownValue,
  LoadedSourceType,
  OriginAttributeSpec,
  PlainConfig,
  SecretStore,
  Source,
  SourceRepository,
  SourceTypeRegistry,
  SourceTypeRepository,
} from "./ports";
import { runContextOf } from "./sources";

export type AttributionRulesDeps = {
  clock: Clock;
  /** The IANA time zone the Family lives in, which plugins are run in. */
  timeZone: string;
  families: FamilyRepository;
  members: FamilyMemberRepository;
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  sources: SourceRepository;
  secrets: SecretStore;
  rules: AttributionRuleRepository;
};

/** What a rule can match on: one Origin attribute of one Source, as its plugin declares it. */
export type RuleTarget = {
  sourceId: SourceId;
  /** The Source Type's name, or its id if its plugin is no longer installed. */
  sourceName: MultilingualText;
  /** The Source's plain settings, to tell Sources of one Source Type apart. */
  sourcePlain: PlainConfig;
  attribute: string;
  /** As the plugin labels the attribute, or its key if the plugin cannot be loaded. */
  attributeLabel: MultilingualText;
};

export type AttributionRuleSummary = RuleTarget & {
  id: AttributionRuleId;
  value: string;
  concerns: Attribution;
};

/** What the rule form offers for a target: the values seen in its Origins and those its plugin knows. */
export type RuleForm = RuleTarget & { knownValues: KnownValue[] };

export type RuleInput = { value: string; concerns: Attribution };

export type RuleProblem = "invalid-value" | "unknown-member" | "no-one-concerned" | "rule-exists";

export type CreateRuleResult =
  | { ok: true; id: AttributionRuleId }
  | { ok: false; problem: RuleProblem | "unknown-source" | "unknown-attribute" };

export type EditRuleResult = { ok: true } | { ok: false; problem: RuleProblem | "unknown-rule" };

export function createAttributionRuleAccess(deps: AttributionRulesDeps) {
  const { clock, timeZone, families, members, registry, sourceTypes, sources, secrets, rules } = deps;

  /** The plugin of an enabled Source Type, or null. */
  async function enabled(sourceTypeId: SourceTypeId): Promise<LoadedSourceType | null> {
    const record = (await sourceTypes.list()).find((type) => type.id === sourceTypeId);
    const loaded = record?.enabled ? await registry.load(sourceTypeId) : null;
    return loaded?.ok ? loaded.sourceType : null;
  }

  function targetOf(source: Source, attribute: string, spec: OriginAttributeSpec | undefined): RuleTarget {
    const installed = registry.installed().find((type) => type.id === source.sourceTypeId);
    return {
      sourceId: source.id,
      sourceName: installed?.displayName ?? source.sourceTypeId,
      sourcePlain: source.plain,
      attribute,
      attributeLabel: spec?.label ?? attribute,
    };
  }

  /** The Origin attribute a Source's plugin declares under the key, with the Source; null if it does not. */
  async function declared(sourceId: SourceId, attribute: string) {
    const source = await sources.findById(sourceId);
    if (!source) return null;
    const spec = (await enabled(source.sourceTypeId))?.originAttributes.find((candidate) => candidate.key === attribute);
    return { source, spec };
  }

  /** Who the input says a rule concerns, the Family Members in the Family's order, or a problem. */
  async function checked(
    input: RuleInput,
  ): Promise<{ ok: true; value: string; concerns: Attribution } | { ok: false; problem: RuleProblem }> {
    const value = parseAttributeValue(input.value);
    if (value === null) return { ok: false, problem: "invalid-value" };
    if (input.concerns === "whole-family") return { ok: true, value, concerns: "whole-family" };
    if (input.concerns.length === 0) return { ok: false, problem: "no-one-concerned" };
    const known = (await members.list(await families.theFamily())).map((member) => member.id);
    const chosen = input.concerns;
    if (!chosen.every((id) => known.includes(id))) return { ok: false, problem: "unknown-member" };
    return { ok: true, value, concerns: known.filter((id) => chosen.includes(id)) };
  }

  async function summaryOf(rule: AttributionRule): Promise<AttributionRuleSummary | null> {
    const found = await declared(rule.sourceId, rule.attribute);
    if (!found) return null;
    return { ...targetOf(found.source, rule.attribute, found.spec), id: rule.id, value: rule.value, concerns: rule.concerns };
  }

  return {
    async list(): Promise<AttributionRuleSummary[]> {
      const all = await rules.list(await families.theFamily());
      const summaries = await Promise.all(all.map(summaryOf));
      return summaries.filter((summary) => summary !== null);
    },

    async find(id: AttributionRuleId): Promise<AttributionRuleSummary | null> {
      const rule = await rules.findById(id);
      return rule ? summaryOf(rule) : null;
    },

    /** What rules can match on: the Origin attributes of the Sources of enabled Source Types. */
    async targets(): Promise<RuleTarget[]> {
      const targets: RuleTarget[] = [];
      for (const source of await sources.list(await families.theFamily())) {
        const sourceType = await enabled(source.sourceTypeId);
        for (const spec of sourceType?.originAttributes ?? []) targets.push(targetOf(source, spec.key, spec));
      }
      return targets;
    },

    /**
     * The form for a rule on the Source's attribute, with the values its recorded Origins carry
     * and those its plugin knows of, such as the senders of recent mail; null if the Source's
     * plugin declares no such attribute.
     */
    async form(sourceId: SourceId, attribute: string): Promise<RuleForm | null> {
      const found = await declared(sourceId, attribute);
      if (!found?.spec) return null;
      const { source, spec } = found;
      const offered = new Map<string, string>();
      for (const value of await rules.seenValues(sourceId, attribute)) offered.set(value, value);
      const context = await runContextOf(source, { secrets, now: clock.now(), timeZone });
      for (const known of await spec.knownValues(context)) {
        const value = parseAttributeValue(known.value);
        if (value !== null) offered.set(value, known.label.trim() || value);
      }
      const knownValues = [...offered]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return { ...targetOf(source, attribute, spec), knownValues };
    },

    /** Adds a rule on an Origin attribute the Source's plugin declares; it applies to past Items too. */
    async create(input: RuleInput & { sourceId: SourceId; attribute: string }): Promise<CreateRuleResult> {
      const found = await declared(input.sourceId, input.attribute);
      if (!found) return { ok: false, problem: "unknown-source" };
      if (!found.spec) return { ok: false, problem: "unknown-attribute" };
      const rule = await checked(input);
      if (!rule.ok) return rule;
      const id = randomUUID() as AttributionRuleId;
      const added = await rules.add({
        id,
        familyId: found.source.familyId,
        sourceId: input.sourceId,
        attribute: input.attribute,
        value: rule.value,
        concerns: rule.concerns,
        createdAt: clock.now(),
      });
      return added ? { ok: true, id } : { ok: false, problem: "rule-exists" };
    },

    /** Changes the value a rule matches and whom it concerns; Items are attributed anew. */
    async edit(id: AttributionRuleId, input: RuleInput): Promise<EditRuleResult> {
      const rule = await rules.findById(id);
      if (!rule) return { ok: false, problem: "unknown-rule" };
      const changed = await checked(input);
      if (!changed.ok) return changed;
      const updated = await rules.update({ ...rule, value: changed.value, concerns: changed.concerns });
      return updated ? { ok: true } : { ok: false, problem: "rule-exists" };
    },

    /** Removes a rule; the Items it attributed concern whom the other rules say, or the whole Family. */
    async remove(id: AttributionRuleId): Promise<void> {
      await rules.remove(id);
    },
  };
}

export type AttributionRuleAccess = ReturnType<typeof createAttributionRuleAccess>;
