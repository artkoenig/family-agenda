---
status: proposed
---

# Source Types are plugins that register themselves at startup

The core of Family Butler names no Source Type. WebUntis, ICS calendars, IMAP mailboxes and WhatsApp are each a Source plugin, and a new Source Type is added by installing one more plugin, without touching `domain`, `application`, the Admin area or the database schema. We chose this because the Family's channels change (another school app, a club portal, a second messenger) and each of them should cost one package, not a change that runs through every layer.

A Source plugin is a package that implements the `SourcePlugin` contract from `packages/source-sdk`. The SDK is the only package a plugin may import from Family Butler; dependency-cruiser enforces this as it does the other boundaries (ADR-0002). A plugin declares:

- **Identity**: a stable Source Type id (such as `webuntis`), a display name, its own version and the SDK version it was built against.
- **Configuration**: a schema of plain fields and secret fields. The Admin area renders the Source step of the wizard and the Fix button ([How do Admins find out that a Source has broken?](https://github.com/artkoenig/family-buttler/issues/25)) from it. Secret fields go to the `SecretStore` and reach the plugin only at run time. A plugin that needs an interactive step, such as pairing WhatsApp by QR code, declares it as a setup step the wizard shows.
- **Ingestion**: either polling, where the worker calls the plugin on an interval it suggests and the Admin can change, or push, where the Instance gives each Source of that type an ingest endpoint for the plugin's own process to deliver to.
- **Output**: Origins. An Origin carries either a raw message (text and attachments) for the extraction pipeline, or structured Revisions when the Source Type is structured itself, as WebUntis and ICS are. Revisions from plugins are applied like any other (ADR-0009).
- **Origin attributes**: the attributes an Attribution Rule can match on, such as sender, group, calendar or Untis child, with their known values for the wizard's rule suggestions.
- **Health**: whether the Silent status applies, and which of its errors are definite rather than temporary.

Plugins hold no state of their own outside the SDK. Each Source gets an opaque state blob, such as a sync token or the last IMAP UID, that the core stores and hands back on the next run. The `sources` table keeps the Source Type id, the plain configuration as JSON and references to secrets, so a new Source Type needs no migration. A plugin that changes its configuration schema ships a migration from older versions, which the core runs at startup.

## Registration

At startup the composition root discovers plugins and registers each with a `SourceRegistry`. It looks in two places: the installed workspace packages that declare a `familyButler.sourcePlugin` entry in their `package.json`, and a `plugins/` directory in its own volume, for plugins an operator adds to a stock image. A plugin is loaded only when its SDK version is compatible, and is otherwise listed in the Admin area as not loaded, with the reason. Everything after registration (the wizard, the scheduler, the ingest endpoints, the Source status) asks the registry and never branches on a Source Type id.

The four v1 Source Types ship as plugins in this repository (`packages/source-webuntis`, `source-ics`, `source-imap`, `source-whatsapp`) and are installed in the default image. They use the same contract as any other plugin, which keeps the contract honest.

## Consequences

- A plugin runs in the `api` and `worker` processes with their full rights, and sees decrypted credentials of its own Sources. Plugins are not sandboxed, so an operator installs only plugins they trust, as with Home Assistant's custom integrations.
- A plugin that needs a process of its own, such as the Go whatsmeow sidecar (ADR-0001), ships it as a container and talks to the Instance only through its push ingest endpoint. The plugin package holds the TypeScript side; the container is enabled with a Compose profile.
- When a plugin is removed, its Sources stay, with their Origins and Revisions, and show as Failing with "Source Type not installed". Reinstalling the plugin resumes them from their stored state.
- Every Source Type, built in or added, is bound by ADR-0004: it runs on the Instance, never in Butler Cloud.
- The `SourceAdapter` port of ADR-0002 becomes the `SourcePlugin` contract, and the Sources leave `packages/adapters-*` for `packages/source-*`.

## Considered Options

- **A fixed list of Source Types in the core, one adapter per type**: simplest to start with, but every new Source Type changes the domain, the wizard, the schema and the composition root.
- **Plugins as separate services over HTTP or gRPC**: isolated and language-independent, but every Source would need its own container and its own protocol for configuration and state. The push ingest endpoint keeps this path open for a plugin that wants it, as the WhatsApp sidecar does.
- **Plugins installed from a registry at run time from the Admin area**: convenient, but it means downloading and running code on the Family's Instance from a web form. Operators add plugins to the image or the `plugins/` volume instead.
