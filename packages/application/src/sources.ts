import { randomUUID } from "node:crypto";
import type { SourceId, SourceTypeId } from "@family-butler/domain";
import type {
  Clock,
  FamilyRepository,
  PlainConfig,
  SecretRef,
  SecretStore,
  SourceRepository,
  SourceTypeRegistry,
  SourceTypeRepository,
} from "./ports";

export type SourcesDeps = {
  clock: Clock;
  families: FamilyRepository;
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  sources: SourceRepository;
  secrets: SecretStore;
};

export type SourceSummary = { id: SourceId; sourceTypeId: SourceTypeId; plain: PlainConfig };

export type AddSourceResult =
  | { ok: true; id: SourceId }
  | { ok: false; problem: "source-type-not-enabled" }
  /** `fields` are the keys that are missing, unknown, or given as plain instead of secret. */
  | { ok: false; problem: "invalid-config"; fields: string[] };

export function createSourceAccess(deps: SourcesDeps) {
  const { clock, families, registry, sourceTypes, sources, secrets } = deps;

  return {
    async list(): Promise<SourceSummary[]> {
      const all = await sources.list(await families.theFamily());
      return all.map(({ id, sourceTypeId, plain }) => ({ id, sourceTypeId, plain }));
    },

    /** Adds a Source of an enabled Source Type, configured by the fields its plugin declares. */
    async add(input: {
      sourceTypeId: string;
      plain: PlainConfig;
      secrets: Record<string, string>;
    }): Promise<AddSourceResult> {
      const sourceTypeId = input.sourceTypeId as SourceTypeId;
      const record = (await sourceTypes.list()).find((type) => type.id === sourceTypeId);
      const loaded = record?.enabled ? await registry.load(sourceTypeId) : null;
      if (!loaded?.ok) return { ok: false, problem: "source-type-not-enabled" };

      const { configuration } = loaded.sourceType;
      const invalid = new Set<string>();
      const given = (key: string, secret: boolean) => {
        const value = secret ? input.secrets[key] : input.plain[key];
        return value !== undefined && value !== null && value !== "";
      };
      for (const field of configuration.fields) {
        if (field.required && !given(field.key, field.secret)) invalid.add(field.key);
        if (given(field.key, !field.secret)) invalid.add(field.key);
      }
      const declared = new Set(configuration.fields.map((field) => field.key));
      for (const key of [...Object.keys(input.plain), ...Object.keys(input.secrets)]) {
        if (!declared.has(key)) invalid.add(key);
      }
      if (invalid.size > 0) return { ok: false, problem: "invalid-config", fields: [...invalid].sort() };

      const refs: Record<string, SecretRef> = {};
      for (const [key, value] of Object.entries(input.secrets)) {
        if (value !== "") refs[key] = await secrets.put(value);
      }
      const id = randomUUID() as SourceId;
      await sources.add({
        id,
        familyId: await families.theFamily(),
        sourceTypeId,
        plain: input.plain,
        configVersion: configuration.version,
        secrets: refs,
        state: null,
        createdAt: clock.now(),
      });
      return { ok: true, id };
    },

    /** Removes the Source and its secrets. */
    async remove(id: SourceId): Promise<void> {
      const source = await sources.findById(id);
      if (!source) return;
      await sources.remove(id);
      for (const ref of Object.values(source.secrets)) await secrets.remove(ref);
    },
  };
}

export type SourceAccess = ReturnType<typeof createSourceAccess>;
