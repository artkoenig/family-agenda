/**
 * The contract tests every plugin passes, whatever it is written in: they speak HTTP to a plugin
 * URL, or call a handler in-process, and validate every answer against the plugin contract. This
 * module needs no vitest; `./vitest` turns the tests into a suite.
 */
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
  /** The IANA time zone of the Family the plugin is polled for; by default Europe/Berlin. */
  timeZone?: string;
};

/** Calls an endpoint of a plugin under test. */
export type Call = ReturnType<typeof pluginClient>;

/** One contract test: what it checks, and the problems it finds in a plugin. */
export type ContractCheck = { name: string; problems: (call: Call) => Promise<string[]> };

/** The problems with an answer to `name`: a wrong status or a body the contract does not allow. */
export function answerProblems(name: EndpointName, answer: Answer): string[] {
  const endpoint: Endpoint = endpoints[name];
  if (answer.status >= 300) return [`${name} answered ${answer.status}: ${JSON.stringify(answer.body)}`];
  if (endpoint.response === undefined) return answer.status === 204 ? [] : [`${name} answered ${answer.status}, not 204`];
  const result = endpoint.response.safeParse(answer.body);
  return result.success ? [] : [`${name} answered invalidly: ${result.error.message}`];
}

type Checked<T> = { ok: true; body: T } | { ok: false; problems: string[] };

/** Calls `name` and checks its answer against the contract; `parse` reads the body once it is valid. */
async function checkedCall<T>(call: Call, name: EndpointName, parse: (body: unknown) => T, body?: unknown): Promise<Checked<T>> {
  const answer = await call(name, body);
  const problems = answerProblems(name, answer);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, body: parse(answer.body) };
}

/** Like `checkedCall`, for an answer that later checks depend on: a problem fails the check at once. */
async function validBody<T>(call: Call, name: EndpointName, parse: (body: unknown) => T): Promise<T> {
  const checked = await checkedCall(call, name, parse);
  if (!checked.ok) throw new Error(checked.problems.join("; "));
  return checked.body;
}

const descriptionOf = (call: Call): Promise<Description> => validBody(call, "description", (body) => descriptionSchema.parse(body));

async function describesItself(call: Call): Promise<string[]> {
  const checked = await checkedCall(call, "description", (body) => descriptionSchema.parse(body));
  if (!checked.ok) return checked.problems;
  const problem = loadProblem(checked.body.contractVersion);
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
  const { entries } = await validBody(call, "catalogueEntries", (body) => endpoints.catalogueEntries.response.parse(body));
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

/** Where a text is not given in `language`. */
async function untranslatedTexts(call: Call, language: string): Promise<string[]> {
  const texts = await textsOf(call);
  const given = (text: unknown) => {
    const translation = typeof text === "object" && text !== null ? (text as Record<string, unknown>)[language] : undefined;
    return typeof translation === "string" && translation.trim() !== "";
  };
  return texts.filter(([, text]) => !given(text)).map(([where]) => `${where} is not given in ${language}`);
}

type PollRun = { result: IngestResult; declared: Set<string> };

function pollOnce(call: Call, context: object, syncCursor: string | null, declared: Set<string>): Promise<Checked<PollRun>> {
  return checkedCall(
    call,
    "poll",
    (body) => {
      const result = endpoints.poll.response.parse(body);
      return { result, declared: declaredAfter(declared, result.attributes ?? { declared: [], archived: [] }) };
    },
    { ...context, syncCursor },
  );
}

/** The Source Attributes declared and not archived after a run, as the core keeps them. */
function declaredAfter(before: Set<string>, attributes: NonNullable<IngestResult["attributes"]>): Set<string> {
  const after = new Set(before);
  for (const { externalId } of attributes.declared) after.add(externalId);
  for (const id of attributes.archived) after.delete(id);
  return after;
}

function undeclared(run: PollRun): string[] {
  const named = run.result.sourceRecords.flatMap((record) => record.attributes.filter((id) => !run.declared.has(id)).map((id) => `Source Record ${record.externalId} names undeclared Source Attribute ${id}`));
  return [...new Set(named)];
}

/** Polls twice, the second time with the sync cursor of the first, as the core would for one Source. */
async function pollsASource(call: Call, options: ContractOptions): Promise<string[]> {
  const description = await descriptionOf(call);
  if (description.ingestion.mode !== "polling" || options.config === undefined) return [];
  const context = { config: options.config, now: (options.now ?? new Date()).toISOString(), timeZone: options.timeZone ?? "Europe/Berlin" };
  const first = await pollOnce(call, context, null, new Set());
  if (!first.ok) return first.problems;
  const second = await pollOnce(call, context, first.body.result.syncCursor, first.body.declared);
  if (!second.ok) return second.problems;
  const repeated = second.body.result.sourceRecords.filter((record) => record.content.kind === "raw-message").map((record) => `message ${record.externalId} came again with the sync cursor of the first run`);
  return [...undeclared(first.body), ...undeclared(second.body), ...repeated];
}

/** The contract tests, each run on its own against a plugin's client. */
export function contractChecks(options: ContractOptions = {}): ContractCheck[] {
  return [
    { name: "describes itself for this contract version", problems: (call) => describesItself(call) },
    { name: "refuses an invalid request with a definite error", problems: (call) => refusesInvalidRequests(call) },
    { name: "lists setup steps, configuration fields and catalogue entries once each", problems: (call) => listsEverythingOnce(call) },
    { name: "migrates a configuration of every older version", problems: (call) => migratesEveryVersion(call) },
    ...(options.languages ?? []).map((language) => ({ name: `gives every text in ${language} too`, problems: (call: Call) => untranslatedTexts(call, language) })),
    { name: "polls a Source validly, declaring Source Attributes before naming them", problems: (call) => pollsASource(call, options) },
  ];
}

/** Every problem the contract tests find; needs no vitest. */
export async function contractProblems(target: PluginTarget, options: ContractOptions = {}): Promise<string[]> {
  const call = pluginClient(target);
  const problems: string[] = [];
  for (const check of contractChecks(options)) problems.push(...(await check.problems(call)));
  return problems;
}
