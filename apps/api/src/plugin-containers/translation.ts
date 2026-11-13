import type { AttributeReporting, CalledSource, LoadedSourceType, SetupProgress, SourceRunContext, SourceRunResult } from "@family-agenda/application";
import { limits, type Description, type EndpointName, type EndpointResponse, type IngestResult, type RunContext } from "@family-agenda/plugin-contract";
import type { CallResult } from "./transport";

/** Calls one endpoint of a Source Type's plugin. */
export type PluginCall = <N extends EndpointName>(name: N, body?: unknown) => Promise<CallResult<N>>;

/** The proxy URL, with a ticket, a call of endpoint `name` for `source` carries; null for a call of no Source. */
export type EgressProxyOf = (source: CalledSource | null, name: EndpointName) => string;

/** A Source Type as the core uses it, every function a call to its plugin container. */
export function loadedSourceType(description: Description, call: PluginCall, egressProxyOf: EgressProxyOf): LoadedSourceType {
  const runContextOf = (name: EndpointName, context: Omit<SourceRunContext, "syncCursor"> & { syncCursor?: string | null }): RunContext => {
    const { plain, secrets, syncCursor = null, now, timeZone, source } = context;
    return { config: { plain, secrets }, syncCursor, now: now.toISOString(), timeZone, egressProxy: egressProxyOf(source, name) };
  };
  const { configuration, ingestion, catalogue } = description;
  return {
    configuration: {
      version: configuration.version,
      fields: configuration.fields.map(({ key, label, secret, required, description: about, setByPlugin, hasChoices, host }) => ({
        key,
        label,
        secret,
        required,
        description: about ?? null,
        setByPlugin: setByPlugin === true,
        host: host === true,
        choice: hasChoices,
      })),
    },
    setupSteps: description.setupSteps.map(({ id, title, description: about, live }) => ({ id, title, description: about, live })),
    async migrateConfig(plain, fromVersion) {
      let migrated = plain;
      // One version up per call, as the contract has it.
      for (let version = fromVersion; version < configuration.version; version++) {
        const answer = await call("configMigration", { fromVersion: version, plain: migrated });
        if (!answer.ok) throw new Error(`Migrating the configuration from version ${version} failed: ${answer.message}`);
        migrated = answer.body.plain;
      }
      return migrated;
    },
    ingestion:
      ingestion.mode === "polling"
        ? {
            mode: "polling",
            suggestedIntervalSeconds: ingestion.suggestedIntervalSeconds,
            poll: async (context, attributes) => runOf(await call("poll", runContextOf("poll", context)), attributes),
          }
        : {
            mode: "push",
            receive: async (context, payload, attributes) => {
              const request = { context: runContextOf("receive", context), payload: Buffer.from(payload).toString("base64") };
              const size = Buffer.byteLength(JSON.stringify(request));
              if (size > limits.maxPayloadBytes) {
                return { ok: false, kind: "definite", message: `The request to receive is ${size} bytes, more than the ${limits.maxPayloadBytes} bytes the plugin contract allows` };
              }
              return runOf(await call("receive", request), attributes);
            },
          },
    silentApplies: description.silentApplies,
    catalogue: catalogue
      ? {
          title: catalogue.title,
          configKey: catalogue.configKey,
          async entries() {
            const answer = await call("catalogueEntries", { egressProxy: egressProxyOf(null, "catalogueEntries") });
            if (!answer.ok) return { ok: false, message: answer.message };
            return { ok: true, value: answer.body.entries.map((entry) => ({ ...entry, riskNotice: entry.riskNotice ?? null })) };
          },
        }
      : null,
    async choices(field, context) {
      const answer = await call("fieldChoices", { field, context: runContextOf("fieldChoices", context) });
      return answer.ok ? { ok: true, value: answer.body.choices } : { ok: false, message: answer.message };
    },
    async setupProgress(stepId, context) {
      const answer = await call("setupProgress", { stepId, context: runContextOf("setupProgress", context) });
      if (!answer.ok) return { status: "failed", message: answer.message };
      return progressOf(answer.body);
    },
    async sourceAdded(context) {
      if (!description.endpoints.sourceAdded) return { ok: true, plain: {}, secrets: {} };
      const { config, now, timeZone, egressProxy } = runContextOf("sourceAdded", context);
      const answer = await call("sourceAdded", { config, now, timeZone, egressProxy });
      if (!answer.ok) return { ok: false, message: answer.message };
      return { ok: true, plain: answer.body.plain, secrets: answer.body.secrets };
    },
    attributes: description.endpoints.sourceAttributes
      ? async (context) => {
          const answer = await call("sourceAttributes", runContextOf("sourceAttributes", context));
          return answer.ok ? { ok: true, value: answer.body } : { ok: false, message: answer.message };
        }
      : null,
    async sourceRemoved(context) {
      if (!description.endpoints.sourceRemoved) return;
      const answer = await call("sourceRemoved", runContextOf("sourceRemoved", context));
      // The contract ignores a failed cleanup; the core logs to the console like everywhere else.
      if (!answer.ok) console.warn(`Cleaning up after a removed Source of type "${description.sourceTypeId}" failed: ${answer.message}`);
    },
  };
}

function progressOf(progress: EndpointResponse<"setupProgress">): SetupProgress {
  if (progress.status === "waiting") return { status: "waiting", qrCode: progress.qrCode ?? null, message: progress.message ?? null };
  if (progress.status === "done") return { status: "done", message: progress.message ?? null };
  return progress;
}

/** A plugin's answer to `poll` or `receive` as the core records it, or the error it came to. */
async function runOf(answer: CallResult<"poll" | "receive">, attributes: AttributeReporting): Promise<SourceRunResult> {
  if (!answer.ok) return { ok: false, kind: answer.kind, message: answer.message };
  return ingested(answer.body, attributes);
}

/** A plugin's answer to `poll` as the core records it, its Source Attributes reported first. */
async function ingested(result: IngestResult, attributes: AttributeReporting): Promise<SourceRunResult> {
  const timeless = result.sourceRecords.filter((record) => record.content.kind === "raw-message" && record.occurredAt === undefined);
  if (timeless.length > 0) {
    return { ok: false, kind: "definite", message: `The plugin emitted messages without a time: ${timeless.map((record) => record.externalId).join(", ")}` };
  }
  if (result.attributes) {
    await attributes.declare(result.attributes.declared);
    for (const externalId of result.attributes.archived) await attributes.archive(externalId);
  }
  return {
    ok: true,
    syncCursor: result.syncCursor,
    withdrawn: result.withdrawn ?? [],
    secrets: result.secrets ?? {},
    origins: result.sourceRecords.map((record) => ({
      externalId: record.externalId,
      attributes: record.attributes,
      sender: record.sender ?? null,
      subject: record.subject ?? null,
      link: record.link ?? null,
      // A stated Item has no time of its own, even if the plugin gives one.
      occurredAt: record.content.kind === "stated" || record.occurredAt === undefined ? null : new Date(record.occurredAt),
      stated: record.content.kind === "stated" ? (record.content.stated as Record<string, unknown>) : null,
      message:
        record.content.kind === "raw-message"
          ? {
              text: record.content.text,
              attachments: record.content.attachments.map(({ filename, contentType, bytes }) => ({ filename, contentType, bytes: new Uint8Array(Buffer.from(bytes, "base64")) })),
            }
          : null,
    })),
  };
}
