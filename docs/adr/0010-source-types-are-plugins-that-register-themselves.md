---
status: proposed, partly superseded by ADR-0016
---

# Source Types are plugins that register themselves at startup and are enabled by an Admin

The core of Family Agenda names no Source Type. WebUntis, ICS calendars, IMAP mailboxes and WhatsApp are each a Source plugin, and a new Source Type is added by installing one more plugin, without touching `domain`, `application`, the Admin area or the database schema. We chose this because the Family's channels change (another school app, a club portal, a second messenger) and each of them should cost one package, not a change that runs through every layer.

A Source plugin is a package that implements the `SourcePlugin` contract from `packages/source-sdk`. The SDK is the only package a plugin may import from Family Agenda; dependency-cruiser enforces this as it does the other boundaries (ADR-0002). A plugin declares:

- **Identity**: a stable Source Type id (such as `webuntis`), a display name, its own version and the SDK version it was built against.
- **Configuration**: a schema of plain fields and secret fields. The Admin area renders the Source step of the wizard and the Fix button ([How do Admins find out that a Source has broken?](https://github.com/artkoenig/family-buttler/issues/25)) from it. Secret fields go to the `SecretStore` and reach the plugin only at run time. A plugin that needs an interactive step, such as pairing WhatsApp by QR code, declares it as a setup step the wizard shows.
- **Ingestion**: either polling, where the worker calls the plugin on an interval it suggests and the Admin can change, or push, where the Instance gives each Source of that type an ingest endpoint for the plugin's own process to deliver to.
- **Output**: Origins. An Origin carries either a raw message (text and attachments) for the extraction pipeline, or structured Revisions when the Source Type is structured itself, as WebUntis and ICS are. Revisions from plugins are applied like any other (ADR-0009). Its attributes, such as sender, group or calendar, tell where it came from and decide nothing: whom an Item concerns comes from the Source Assignment alone. (Plugins once declared these attributes for Attribution Rules to match on; SDK 0.6.0 dropped both.) The one exception is the Part: a plugin may mark a plain configuration field as a list of Parts, such as the folders of a mailbox, and name the Part on each Origin, so an Admin can assign each Part to Family Members on its own (SDK 0.7.0). The core still names no Source Type; it only stores the Part with the Origin and its assignment.
- **Health**: whether the Silent status applies, and which of its errors are definite rather than temporary.

Plugins hold no state of their own outside the SDK. Each Source gets an opaque state blob, such as a sync token or the last IMAP UID, that the core stores and hands back on the next run. The `sources` table keeps the Source Type id, the plain configuration as JSON and references to secrets, so a new Source Type needs no migration. A plugin that changes its configuration schema ships a migration from older versions, which the core runs at startup.

## Registration

At startup the composition root discovers plugins and registers each with a `SourceRegistry`. It looks in two places: the installed workspace packages that declare a `familyAgenda.sourcePlugin` entry in their `package.json`, and a `plugins/` directory in its own volume, for plugins an operator adds to a stock image. That entry also holds the plugin's manifest: its identity, a short description, whether its Sources need the LLM endpoint, and a risk notice where one applies, such as WhatsApp's (ADR-0001). The registry reads manifests without loading any plugin code. A plugin with an incompatible SDK version is listed in the Admin area as not loadable, with the reason. Everything after registration (the wizard, the scheduler, the ingest endpoints, the Source status) asks the registry and never branches on a Source Type id.

The four v1 Source Types ship as plugins in this repository (`packages/source-webuntis`, `source-ics`, `source-imap`, `source-whatsapp`) and are installed in the default image. They use the same contract as any other plugin, which keeps the contract honest.

## Enabling Source Types

Installed is not enabled. An Admin enables each Source Type the Family uses, and only enabled Source Types are offered when adding a Source. Only their code is loaded, their jobs scheduled and their ingest endpoints served. The Instance stores, per Source Type id, whether it is enabled and in which application version it was first discovered. No Source Type is ever enabled without an Admin, not on first start and not after an update.

- **Onboarding**: the wizard gets a Source Types step after Family Members and before the LLM step ([What does onboarding look like in the Admin area?](https://github.com/artkoenig/family-buttler/issues/21)). It lists every installed Source Type with its description, none preselected. A Source Type with a risk notice needs its acknowledgement before it can be enabled. When only Source Types that need no LLM are chosen, the LLM step says so and can be skipped. Like the other steps, this one can be skipped and changed later in the settings.
- **After an update**: at startup the registry compares the discovered plugins with the stored ones. A Source Type seen for the first time, because a new application version ships it or an operator dropped it into `plugins/`, is recorded as new and stays disabled. The Admin area shows a banner, "New Source Types are available", until an Admin has looked at the list. The list shows the new Source Types first, with the version that brought them, and enables them the same way as the onboarding step does.
- **Disabling**: a Source Type can be disabled only while it has no Sources. An Admin removes those first, which keeps their Origins and Revisions as removing any Source does.

## Consequences

- A plugin runs in the `api` and `worker` processes with their full rights, and sees decrypted credentials of its own Sources. Plugins are not sandboxed, so an operator installs only plugins they trust, as with Home Assistant's custom integrations.
- A plugin that needs programs of its own, such as the Matrix plugin's homeserver and bridges (ADR-0011), declares them as `services`: the image brings the programs, and the worker starts them while the Source Type and the catalogue entries that need them are enabled, and stops them once they are not. A plugin added to the `plugins/` volume can only run programs the image has.
- An update can bring new Source Types, but never turns one on. A plugin that is installed and disabled costs nothing at run time, because its code is not loaded.
- When a plugin is removed, its Sources stay, with their Origins and Revisions, and show as Failing with "Source Type not installed". Reinstalling the plugin resumes them from their stored state.
- Every Source Type, built in or added, is bound by ADR-0004: it runs on the Instance, never in Agenda Cloud.
- The `SourceAdapter` port of ADR-0002 becomes the `SourcePlugin` contract, and the Sources leave `packages/adapters-*` for `packages/source-*`.

## Considered Options

- **A fixed list of Source Types in the core, one adapter per type**: simplest to start with, but every new Source Type changes the domain, the wizard, the schema and the composition root.
- **Plugins as separate services over HTTP or gRPC**: isolated and language-independent, but every Source would need its own container and its own protocol for configuration and state. The push ingest endpoint keeps this path open for a plugin that wants it, as the WhatsApp sidecar does.
- **Plugins installed from a registry at run time from the Admin area**: convenient, but it means downloading and running code on the Family's Instance from a web form. Operators add plugins to the image or the `plugins/` volume instead.
- **Enabling every installed Source Type automatically**: one step less in onboarding, but an update would quietly start loading new code, and a risky Source Type such as WhatsApp would be on without its acknowledgement.

_Amended by ADR-0011: the four v1 Source Types are WebUntis, ICS, IMAP and Matrix (`packages/source-matrix`), which reads WhatsApp and other Messengers through bridges. Where this ADR names WhatsApp's pairing step, risk notice or whatsmeow sidecar, these now belong to the WhatsApp Messenger of the Matrix plugin and its bridge container._

_Amended by ADR-0016: a Source Record carries a raw message or a stated Item, never Revisions, and the SDK drops its Revisions vocabulary. Parts and the `parts: true` field give way to Source Attributes, which the plugin reports through `attributes.declare` and `attributes.archive` on polls and on `receive`. In a Source Record, `attributes` lists only Source Attribute ids. The `folders` and `chats` allow-lists stay a pre-filter. The "New Source Types are available" banner and the stored first-seen version are dropped: a newly discovered Source Type or Catalogue entry simply appears disabled. The state blob is `source_run.sync_cursor`. Removing a plugin keeps its Sources' Source Records and Items._

_Amended by ADR-0016 (stated Tasks): a plugin may state a Task as well as an Event or a Lesson, and the SDK is 1.0.0. A plugin built for 0.x does not load and has to be rebuilt against the SDK once; from 1.0.0 on, a plugin loads on any SDK of its major whose minor is at least the one it was built for._

_Amended by the release process: the SDK has a version of its own, `version` in `packages/source-sdk/package.json`, which is also the `sdkVersion` constant (a test keeps them equal) and does not follow the version of the app. `packages/source-sdk/api.txt` holds its public API as declarations, written by `pnpm sdk-api`; a test fails when it is out of date. Since the last release, a change that removes or changes a declaration needs a new major version (a new minor while the major is 0), an added one a new minor (a new patch while the major is 0), which CI and the release check. The "Upgrading" section of a release says when an update makes plugins built for the old SDK unloadable._
