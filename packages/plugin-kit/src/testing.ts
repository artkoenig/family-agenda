/**
 * The contract tests every plugin passes, whatever it is written in: they speak HTTP to a plugin
 * URL, or call a handler in-process, and validate every answer against the plugin contract.
 */
import { describe, expect, it } from "vitest";
import { descriptionSchema, endpoints, errorSchema, loadProblem, type Description, type Endpoint, type IngestResult } from "@family-agenda/plugin-contract";
import type { EndpointName } from "./index";
import type { PluginHandler } from "./server";

/** A plugin under test: its base URL, such as `http://localhost:8080`, or its handler. */
export type PluginTarget = string | PluginHandler;

export type Answer = { status: number; body: unknown };

/** Calls the endpoints of a plugin as the core does. */
export function pluginClient(target: PluginTarget): (name: EndpointName, body?: unknown) => Promise<Answer> {
  const base = typeof target === "string" ? target.replace(/\/$/, "") : "https://plugin.invalid";
  const send = typeof target === "string" ? fetch : target;
  return async (name, body) => {
    const endpoint: Endpoint = endpoints[name];
    const init: RequestInit = { method: endpoint.method.toUpperCase(), headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await send(new Request(base + endpoint.path, init));
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
  };
}

export type ContractOptions = {
  /** A configuration to poll the plugin with; without it, the plugin is not polled. */
  config?: { plain: Record<string, unknown>; secrets: Record<string, string> };
  /** The time of that run; by default the current time. */
  now?: Date;
  /** Languages besides English that every text of the plugin is given in, such as `["de"]`. */
  languages?: string[];
};

/** One contract test: what it checks, and the problems it finds. */
export type ContractCheck = { name: string; problems: () => Promise<string[]> };

type Call = ReturnType<typeof pluginClient>;

/** The problems with an answer to `name`: a wrong status or a body the contract does not allow. */
export function answerProblems(name: EndpointName, answer: Answer): string[] {
  const endpoint: Endpoint = endpoints[name];
  if (answer.status >= 300) return [`${name} answered ${answer.status}: ${JSON.stringify(answer.body)}`];
  if (endpoint.response === undefined) return answer.status === 204 ? [] : [`${name} answered ${answer.status}, not 204`];
  const result = endpoint.response.safeParse(answer.body);
  return result.success ? [] : [`${name} answered invalidly: ${result.error.message}`];
}

async function descriptionOf(call: Call): Promise<Description> {
  const answer = await call("description");
  const problems = answerProblems("description", answer);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return descriptionSchema.parse(answer.body);
}

async function describesItself(call: Call): Promise<string[]> {
  const answer = await call("description");
  const problems = answerProblems("description", answer);
  if (problems.length > 0) return problems;
  const problem = loadProblem(descriptionSchema.parse(answer.body).contractVersion);
  return problem === null ? [] : [problem];
}

async function refusesInvalidRequests(call: Call): Promise<string[]> {
  const answer = await call("poll", { config: "not a configuration" });
  const definite = answer.status >= 400 && answer.status < 500 && errorSchema.safeParse(answer.body).data?.kind === "definite";
  return definite ? [] : [`an invalid poll request was answered ${answer.status}, not with a definite error`];
}

function duplicates(ids: string[], what: string): string[] {
  return ids.filter((id, index) => ids.indexOf(id) !== index).map((id) => `${what} ${id} is listed more than once`);
}

async function catalogueEntries(call: Call): Promise<{ id: string; texts: unknown[] }[]> {
  const answer = await call("catalogueEntries");
  const problems = answerProblems("catalogueEntries", answer);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { entries } = endpoints.catalogueEntries.response.parse(answer.body);
  return entries.map((entry) => ({ id: entry.id, texts: [entry.displayName, entry.description, entry.riskNotice] }));
}

async function listsEverythingOnce(call: Call): Promise<string[]> {
  const description = await descriptionOf(call);
  const problems = [...duplicates(description.setupSteps.map((step) => step.id), "setup step"), ...duplicates(description.configuration.fields.map((field) => field.key), "configuration field")];
  if (description.catalogue) problems.push(...duplicates((await catalogueEntries(call)).map((entry) => entry.id), "catalogue entry"));
  return problems;
}

async function migratesEveryVersion(call: Call): Promise<string[]> {
  const { configuration } = await descriptionOf(call);
  const problems: string[] = [];
  for (let fromVersion = 1; fromVersion < configuration.version; fromVersion++) {
    problems.push(...answerProblems("configMigration", await call("configMigration", { fromVersion, plain: {} })));
  }
  return problems;
}

/** Every text a plugin shows, by where it comes from. */
async function textsOf(call: Call): Promise<[string, unknown][]> {
  const description = await descriptionOf(call);
  const texts: [string, unknown][] = [
    ["displayName", description.displayName],
    ["description", description.description],
    ["riskNotice", description.riskNotice],
  ];
  for (const field of description.configuration.fields) texts.push([`configuration field ${field.key}'s label`, field.label], [`configuration field ${field.key}'s description`, field.description]);
  for (const step of description.setupSteps) texts.push([`setup step ${step.id}'s title`, step.title], [`setup step ${step.id}'s description`, step.description]);
  if (description.catalogue) {
    texts.push(["the catalogue's title", description.catalogue.title]);
    for (const entry of await catalogueEntries(call)) texts.push(...entry.texts.map((text): [string, unknown] => [`catalogue entry ${entry.id}`, text]));
  }
  return texts.filter(([, text]) => text !== undefined);
}

async function speaks(call: Call, language: string): Promise<string[]> {
  const texts = await textsOf(call);
  const given = (text: unknown) => {
    const translation = typeof text === "object" && text !== null ? (text as Record<string, unknown>)[language] : undefined;
    return typeof translation === "string" && translation.trim() !== "";
  };
  return texts.filter(([, text]) => !given(text)).map(([where]) => `${where} is not given in ${language}`);
}

type Run = { result: IngestResult; declared: Set<string> };

async function pollOnce(call: Call, context: object, syncCursor: string | null, declared: Set<string>): Promise<Run | string[]> {
  const answer = await call("poll", { ...context, syncCursor });
  const problems = answerProblems("poll", answer);
  if (problems.length > 0) return problems;
  const result = endpoints.poll.response.parse(answer.body);
  return { result, declared: declaredAfter(declared, result.attributes ?? { declared: [], archived: [] }) };
}

/** The Source Attributes declared and not archived after a run, as the core keeps them. */
function declaredAfter(before: Set<string>, attributes: NonNullable<IngestResult["attributes"]>): Set<string> {
  const after = new Set(before);
  for (const { externalId } of attributes.declared) after.add(externalId);
  for (const id of attributes.archived) after.delete(id);
  return after;
}

function undeclared(run: Run): string[] {
  const named = run.result.sourceRecords.flatMap((record) => record.attributes.filter((id) => !run.declared.has(id)).map((id) => `Source Record ${record.externalId} names undeclared Source Attribute ${id}`));
  return [...new Set(named)];
}

/** Polls twice, the second time with the sync cursor of the first, as the core would for one Source. */
async function pollsASource(call: Call, options: ContractOptions): Promise<string[]> {
  const description = await descriptionOf(call);
  if (description.ingestion.mode !== "polling" || options.config === undefined) return [];
  const context = { config: options.config, now: (options.now ?? new Date()).toISOString(), timeZone: "Europe/Berlin" };
  const first = await pollOnce(call, context, null, new Set());
  if (Array.isArray(first)) return first;
  const second = await pollOnce(call, context, first.result.syncCursor, first.declared);
  if (Array.isArray(second)) return second;
  const repeated = second.result.sourceRecords.filter((record) => record.content.kind === "raw-message").map((record) => `message ${record.externalId} came again with the sync cursor of the first run`);
  return [...undeclared(first), ...undeclared(second), ...repeated];
}

/** The contract tests for a plugin, each run on its own. */
export function contractChecks(target: PluginTarget, options: ContractOptions = {}): ContractCheck[] {
  const call = pluginClient(target);
  return [
    { name: "describes itself for this contract version", problems: () => describesItself(call) },
    { name: "refuses an invalid request with a definite error", problems: () => refusesInvalidRequests(call) },
    { name: "lists setup steps, configuration fields and catalogue entries once each", problems: () => listsEverythingOnce(call) },
    { name: "migrates a configuration of every older version", problems: () => migratesEveryVersion(call) },
    ...(options.languages ?? []).map((language) => ({ name: `gives every text in ${language} too`, problems: () => speaks(call, language) })),
    { name: "polls a Source validly, declaring Source Attributes before naming them", problems: () => pollsASource(call, options) },
  ];
}

/** Every problem the contract tests find, for a plugin tested without vitest. */
export async function contractProblems(target: PluginTarget, options: ContractOptions = {}): Promise<string[]> {
  const problems: string[] = [];
  for (const check of contractChecks(target, options)) problems.push(...(await check.problems()));
  return problems;
}

/**
 * The contract tests as a vitest suite, called from the plugin's own test file. `target` is asked
 * for the plugin in each test, so that a server started in `beforeAll` can be tested by its URL.
 */
export function describePluginContract(target: () => PluginTarget, options: ContractOptions = {}): void {
  describe("plugin contract", () => {
    const names = contractChecks("https://unused.invalid", options).map((check) => check.name);
    names.forEach((name, index) => {
      it(name, async () => {
        const check = contractChecks(target(), options)[index];
        expect(await check?.problems()).toEqual([]);
      });
    });
  });
}
