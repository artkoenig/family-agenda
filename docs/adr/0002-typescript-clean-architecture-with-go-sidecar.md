# TypeScript backend in Clean Architecture, with a Go sidecar for WhatsApp

Family Butler is a TypeScript monorepo on Node.js LTS that follows Clean Architecture. Go is used only in a small WhatsApp sidecar, because whatsmeow is a Go library. Python had the strongest libraries for PDF, OCR and ICS recurrence. We still chose TypeScript, so that the backend, the REST API and the React frontend share one language and their contracts, and we close the library gaps with the poppler and tesseract command-line tools and `ical.js`.

The dependency rule is enforced by workspace package boundaries and dependency-cruiser, not by convention:

- `packages/domain`: plain TypeScript with no dependencies, including no zod.
- `packages/application`: use cases and ports (`SourceAdapter`, `Extractor`, `TextExtractor`, `JobQueue`).
- `packages/adapters-*`: Postgres via Drizzle, the Sources, the LLMs and pg-boss.
- `packages/contracts`: zod schemas for the DTOs.
- `apps/api`: Hono, and the composition root.
- `apps/web`: the React frontend, which imports only `contracts`.

The sidecar holds no domain logic. It keeps its own whatsmeow session store, drops messages from groups that are not allow-listed, and forwards the rest to `api` by webhook.

## Considered Options

- **Python backend with a Go sidecar**: best library fit for three of the four Source areas, but a second language next to the frontend.
- **All Go**: no sidecar, but the Untis client and ICS recurrence would be written by hand.

_The frontend part is amended by ADR-0003: there is no React app, and `apps/api` serves server-rendered HTML next to the REST API._

_Amended by ADR-0010: the Sources are Source plugins in `packages/source-*` that register themselves at startup, and the `SourceAdapter` port becomes the `SourcePlugin` contract in `packages/source-sdk`._
