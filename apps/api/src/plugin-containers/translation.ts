import type { AttributeReporting, LoadedSourceType, SetupProgress, SourceRunContext, SourceRunResult } from "@family-agenda/application";
import { limits, type Description, type EndpointName, type EndpointResponse, type IngestResult, type RunContext } from "@family-agenda/plugin-contract";
import type { CallResult } from "./transport";

/** Calls one endpoint of a Source Type's plugin. */
export type PluginCall = <N extends EndpointName>(name: N, body?: unknown) => Promise<CallResult<N>>;

function runContextOf(context: Omit<SourceRunContext, "syncCursor"> & { syncCursor?: string | null }): RunContext {
  const { plain, secrets, syncCursor = null, now, timeZone } = context;
  return { config: { plain, secrets }, syncCursor, now: now.toISOString(), timeZone };
}

/** A Source Type as the core uses it, every function a call to its plugin container. */
export function loadedSourceType(description: Description, call: PluginCall): LoadedSourceType {
  const { configuration, ingestion, catalogue } = description;
  return {
    configuration: {
      version: configuration.version,
      fields: configuration.fields.map(({ key, label, secret, required, description: about, setByPlugin, hasChoices }) => ({
        key,
        label,
        secret,
        required,
        description: about ?? null,
        setByPlugin: setByPlugin === true,
        choice: hasChoices,
      })),
    },
    setupSteps: description.setupSteps.map(({ id, title, description: about, live }) => ({ id, title, description: about, live })),
    migrateConfig(plain, fromVersion) {
      if (fromVersion >= configuration.version) return plain;
      throw new Error("migrating the configuration of a plugin container is not supported yet");
    },
    ingestion:
      ingestion.mode === "polling"
        ? {
            mode: "polling",
            suggestedIntervalSeconds: ingestion.suggestedIntervalSeconds,
            poll: async (context, attributes) => {
              const answer = await call("poll", runContextOf(context));
              if (!answer.ok) return { ok: false, kind: answer.kind, message: answer.message };
              return ingested(answer.body, attributes);
            },
          }
        : {
            mode: "push",
            receive: async (context, payload, attributes) => {
              const encoded = Buffer.from(payload).toString("base64");
              if (encoded.length > limits.maxPayloadBytes) {
                return { ok: false, kind: "definite", message: `The payload of ${payload.byteLength} bytes is too large for the plugin` };
              }
              const answer = await call("receive", { context: runContextOf(context), payload: encoded });
              if (!answer.ok) return { ok: false, kind: answer.kind, message: answer.message };
              return ingested(answer.body, attributes);
            },
          },
    silentApplies: description.silentApplies,
    catalogue: catalogue
      ? {
          title: catalogue.title,
          configKey: catalogue.configKey,
          async entries() {
            const answer = await call("catalogueEntries");
            if (!answer.ok) return [];
            return answer.body.entries.map((entry) => ({ ...entry, riskNotice: entry.riskNotice ?? null }));
          },
        }
      : null,
    services: null,
    async choices(field, context) {
      const answer = await call("fieldChoices", { field, context: runContextOf(context) });
      return answer.ok ? answer.body.choices : [];
    },
    async setupProgress(stepId, context) {
      const answer = await call("setupProgress", { stepId, context: runContextOf(context) });
      if (!answer.ok) return { status: "failed", message: answer.message };
      return progressOf(answer.body);
    },
    async sourceAdded(context) {
      if (!description.endpoints.sourceAdded) return { ok: true, plain: {}, secrets: {} };
      const { config, now, timeZone } = runContextOf(context);
      const answer = await call("sourceAdded", { config, now, timeZone });
      if (!answer.ok) return { ok: false, message: answer.message };
      return { ok: true, plain: answer.body.plain, secrets: answer.body.secrets };
    },
    async sourceRemoved(context) {
      if (!description.endpoints.sourceRemoved) return;
      const answer = await call("sourceRemoved", runContextOf(context));
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
