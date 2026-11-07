# TypeScript backend in Clean Architecture, with a Go sidecar for WhatsApp

Family Agenda is a TypeScript monorepo on Node.js LTS that follows Clean Architecture. Go is used only in a small WhatsApp sidecar, because whatsmeow is a Go library. Python had the strongest libraries for PDF, OCR and ICS recurrence. We still chose TypeScript, so that the backend, the REST API and the React frontend share one language and their contracts, and we close the library gaps with the poppler and tesseract command-line tools and `ical.js`.

The dependency rule is enforced by workspace package boundaries and dependency-cruiser, not by convention:

- `packages/domain`: plain TypeScript with no dependencies, including no zod.
- `packages/application`: use cases and ports (`SourceAdapter`, `Extractor`, `TextExtractor`).
- `packages/adapters-*`: Postgres via Drizzle, the Sources, the LLMs.
- `packages/contracts`: zod schemas for the DTOs.
- `packages/composition`: the composition root, which wires use cases to adapters for `apps/api` and `apps/worker`.
- `apps/api`: Hono.
- `apps/web`: the React frontend, which imports only `contracts`.

The sidecar holds no domain logic. It keeps its own whatsmeow session store, drops messages from groups that are not allow-listed, and forwards the rest to `api` by webhook.

## Considered Options

- **Python backend with a Go sidecar**: best library fit for three of the four Source areas, but a second language next to the frontend.
- **All Go**: no sidecar, but the Untis client and ICS recurrence would be written by hand.

_The frontend part is amended by ADR-0003: there is no React app, and `apps/api` serves server-rendered HTML next to the REST API._

_Amended by ADR-0010: the Sources are Source plugins in `packages/source-*` that register themselves at startup, and the `SourceAdapter` port becomes the `SourcePlugin` contract in `packages/source-sdk`._

_The Go sidecar is dropped by ADR-0011: Messengers, WhatsApp included, are read through third-party Matrix bridges, and there is no Go code in this repository._

_Amended for serving several Families from one process: a library package keeps no state per process, so that two Instances can live in one process. ESLint bans `process.env`, `process.cwd()`, the time zone of the process and module-scope `let` in `packages/*/src` (exceptions: `source-matrix`, which supports one Instance per process and is "off" by not being in the plugin list, and `composition/src/self-hosted.ts`, which reads the environment). The one allowed global is Node's `registerHooks` in the `SourceRegistry`. The background work keeps its state in a per-Instance `WorkerLoop`. depcruise lets packages reach each other only through their `exports`, and `packages/http` import only `application` and `contracts`. Each package has an `api.txt` of its public API, and `pnpm api-version` (part of `pnpm check`) fails when the API changed since the last release without a matching version bump._
