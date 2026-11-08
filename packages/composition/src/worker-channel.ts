import type { ExtractionReport, PollReport } from "@family-agenda/application";
import type { CleanupReport, FamilyDatabase, WorkerService } from "./worker-service";

/**
 * The channel api triggers the worker on: one POST per kind of work, the Family's database in the
 * body, authenticated by a shared token. The worker answers once the work is done.
 */
const paths = {
  poll: "/poll",
  extract: "/extract",
  cleanup: "/cleanup",
} as const;

type Kind = keyof typeof paths;

type WireFamily = { databaseUrl: string; masterKey: string; blobDirectory: string; timeZone: string };
type WireDue<R> = { report: R; nextDueAt: string | null };

export type WorkerConfig = {
  /** Where the worker listens, such as `http://worker:4200`. */
  url: string;
  /** The token shared with the worker. */
  token: string;
  fetch?: typeof globalThis.fetch;
};

const toWire = (family: FamilyDatabase): WireFamily => ({ ...family, masterKey: family.masterKey.toString("base64") });

function fromWire(body: unknown): FamilyDatabase | null {
  if (typeof body !== "object" || body === null) return null;
  const { databaseUrl, masterKey, blobDirectory, timeZone } = body as Partial<Record<keyof WireFamily, unknown>>;
  if (typeof databaseUrl !== "string" || typeof masterKey !== "string" || typeof blobDirectory !== "string" || typeof timeZone !== "string") return null;
  return { databaseUrl, masterKey: Buffer.from(masterKey, "base64"), blobDirectory, timeZone };
}

const due = <R>(answer: WireDue<R>) => ({ report: answer.report, nextDueAt: answer.nextDueAt === null ? null : new Date(answer.nextDueAt) });

/** Triggers the worker's work for a Family. */
export class WorkerClient {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly config: WorkerConfig) {
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  async poll(family: FamilyDatabase): Promise<{ report: PollReport; nextDueAt: Date | null }> {
    return due(await this.trigger<WireDue<PollReport>>("poll", family));
  }

  async extract(family: FamilyDatabase): Promise<{ report: ExtractionReport; nextDueAt: Date | null }> {
    return due(await this.trigger<WireDue<ExtractionReport>>("extract", family));
  }

  cleanup(family: FamilyDatabase): Promise<CleanupReport> {
    return this.trigger("cleanup", family);
  }

  private async trigger<T>(kind: Kind, family: FamilyDatabase): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(new URL(paths[kind], this.config.url), {
        method: "POST",
        body: JSON.stringify(toWire(family)),
        headers: { authorization: `Bearer ${this.config.token}`, "content-type": "application/json" },
      });
    } catch (error) {
      throw new Error(`The worker cannot be reached: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (response.status === 401) throw new Error("The worker refused the token; WORKER_TOKEN must be the same for it and api.");
    if (!response.ok) throw new Error(`The worker failed "${paths[kind]}" with status ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const wireDue = <R>({ report, nextDueAt }: { report: R; nextDueAt: Date | null }): WireDue<R> => ({ report, nextDueAt: nextDueAt?.toISOString() ?? null });

/** Answers the worker's channel: runs the work a request triggers and answers with its report. */
export function createWorkerHandler(service: WorkerService, token: string): (request: Request) => Promise<Response> {
  const work: Record<Kind, (family: FamilyDatabase) => Promise<unknown>> = {
    poll: async (family) => wireDue(await service.poll(family)),
    extract: async (family) => wireDue(await service.extract(family)),
    cleanup: (family) => service.cleanup(family),
  };
  const kinds = new Map(Object.entries(paths).map(([kind, path]) => [path, kind as Kind]));

  return async (request) => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
    const kind = request.method === "POST" ? kinds.get(new URL(request.url).pathname as (typeof paths)[Kind]) : undefined;
    if (!kind) return json({ error: "not found" }, 404);
    const family = fromWire(await request.json().catch(() => null));
    if (!family) return json({ error: "The body names no Family database." }, 400);
    try {
      return json(await work[kind](family));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };
}
