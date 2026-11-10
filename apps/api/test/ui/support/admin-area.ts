import type { ConfigFieldSpec, SourceForm, SourceSummary, SourceTypeSummary } from "@family-agenda/application";
import type { AdminId, Email, SourceId, SourceTypeId } from "@family-agenda/domain";
import type { Fakes } from "./fake-application";
import { sessionToken } from "./fixtures";

const admin = { id: "admin-1" as AdminId, email: "anna@example.org" as Email };

/**
 * The fakes every page of the Admin area asks for, for an Instance set up with one signed-in Admin
 * and nothing else; `fakes` add to them per access, and win where they name the same method.
 */
export function adminArea(fakes: Fakes = {}): Fakes {
  const base: Fakes = {
    admins: {
      needsFirstAdmin: () => Promise.resolve(false),
      authenticate: (token) => Promise.resolve(token === sessionToken ? admin : null),
      listAdmins: () => Promise.resolve([admin]),
    },
    recoveryKit: { isConfirmed: () => Promise.resolve(true) },
    languages: {
      familyLanguage: () => Promise.resolve("en"),
      current: () => Promise.resolve({ language: "en", ocrEnabled: false, ocrLanguages: [], addable: [] }),
    },
    llmEndpoint: { current: () => Promise.resolve(null) },
    singleSignOn: { current: () => Promise.resolve(null) },
    familyMembers: { list: () => Promise.resolve([]) },
    agendas: { list: () => Promise.resolve([]) },
    sources: { list: () => Promise.resolve([]) },
  };
  const merged: Record<string, unknown> = { ...base };
  for (const [name, given] of Object.entries(fakes)) {
    const known = merged[name];
    // Per access, the test's methods are added to the base ones; a value such as `timeZone` replaces.
    merged[name] = typeof known === "object" && typeof given === "object" ? { ...known, ...given } : given;
  }
  return merged;
}

/** A field an Admin sets on a Source, here a choice among values its plugin offers. */
export function aChoiceField(key: string, label: string): ConfigFieldSpec {
  return { key, label, secret: false, required: false, description: null, setByPlugin: false, choice: true, host: false };
}

/** An enabled, loadable Source Type. */
export function aSourceType(id: string, displayName: string): SourceTypeSummary {
  return {
    id: id as SourceTypeId,
    displayName,
    description: "",
    version: "1.0.0",
    needsLlm: false,
    riskNotice: null,
    notLoadable: null,
    notReachable: null,
    enabled: true,
  };
}

/** The form of a Source Type with `fields`, without catalogue or setup steps. */
export function aSourceForm(sourceTypeId: string, fields: ConfigFieldSpec[]): SourceForm {
  return {
    sourceTypeId: sourceTypeId as SourceTypeId,
    displayName: sourceTypeId,
    fields,
    catalogue: null,
    setupSteps: [],
    suggestedIntervalSeconds: null,
  };
}

/** An OK Source of `sourceTypeId`, read once, with `overrides`. */
export function aSource(sourceTypeId: string, overrides: Partial<SourceSummary> = {}): SourceSummary {
  return {
    id: "source-1" as SourceId,
    sourceTypeId: sourceTypeId as SourceTypeId,
    displayName: sourceTypeId,
    plain: {},
    storedSecrets: [],
    pollIntervalSeconds: null,
    shown: true,
    name: null,
    attributes: [],
    health: {
      status: "ok",
      problem: null,
      lastSuccessAt: new Date("2026-11-01T08:00:00Z"),
      invalidRecords: [],
      unknownAttributes: [],
      awaitingRead: false,
    },
    ...overrides,
  };
}
