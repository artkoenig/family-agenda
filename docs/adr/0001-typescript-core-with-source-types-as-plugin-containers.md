---
status: proposed
---

# The core is TypeScript in Clean Architecture; Source Types are plugin containers it calls over REST

The core of Family Agenda is a TypeScript monorepo on Node.js LTS in Clean Architecture, and it names no Source Type. Every Source Type (ICS, IMAP, WebUntis, Matrix) is a **plugin**: its own repository, its own Docker image, its own versioning, any language. The core calls each plugin container over HTTP/JSON. We chose this for isolation (a plugin sees only its own Sources' secrets and cannot compromise the core), for free choice of language and dependencies per plugin, and so that plugins are updated, restarted and limited one by one.

## The core

- The dependency rule is enforced by workspace package boundaries and dependency-cruiser: `domain` (no dependencies), `application` (use cases, ports), `adapters`, `contracts`, `composition` (the composition root for `apps/api` and `apps/worker`).
- The core is the only holder of stored state: Postgres, the SecretStore, the BlobStore (ADR-0003).

## The plugin contract

- An OpenAPI document is the only contract. It is generated from TypeScript schemas in `packages/plugin-contract`, which the core also validates every request and response with. `packages/plugin-kit` is an optional TypeScript helper (types, server helper, contract test harness) and not part of the contract. Neither is published; plugin repositories consume them as git dependencies.
- `contractVersion` is `major.minor`. A minor change is additive only. The core loads a plugin when the majors match and its own minor is at least the plugin's, and supports one major at a time. A CI diff of the OpenAPI document against the last release fails a breaking change without a major bump and an additive one without a minor bump.
- The core calls; plugins never call the core. Push payloads arrive at the core and are forwarded. A plugin describes itself at `GET /description` (Source Type id, `kind`, fields, setup steps, …), fetched uncached. Every other function is one endpoint (`poll`, `receive`, field choices, Catalogue entries, setup steps, config migration). 4xx with `kind: definite` is a definite error; 5xx, a timeout or an unreachable container is a temporary error. Reachability is derived only from these calls; there is no health endpoint.
- A plugin is either **stateless** (every call carries the Source's configuration, decrypted secrets and Source Cursor; the response returns the new cursor and changed secrets; it MUST NOT persist secrets; it scales horizontally and may be shared by many Instances) or a **singleton** (holds state of its own, runs as exactly one replica per Instance).

## The deployment declares plugins; the Instance never starts containers

Starting containers from inside the Instance needs the Docker socket, which is root on the host, and Podman is not available on every NAS. So the deployment declares which plugin containers run, and the core receives only, as configuration, each Source Type id's URL and each container's fixed egress hosts. The Admin enables Source Types from those that are declared; one that is not enabled gets no calls and no secrets. The core checks that `/description` reports the bound id.

For self-hosting, the operator lists the plugins in `plugins.yml` (id, pinned image, egress hosts, optional limits, companion containers). A generator in the core image turns it into `compose.plugins.yaml`, including the core's own binding and egress configuration. A release ships a default `plugins.yml` pinning tested plugin images. A provider hosting Instances may declare plugins with any orchestrator instead.

## What a plugin can reach

Plugins sit on internal networks without published ports, with no token between core and plugin. A plugin's only way out is its own egress proxy (HTTP CONNECT), which allows the declared hosts plus the hosts the Admin entered in host fields of that plugin's Sources, served to it by the core. Since plugin contract 3.0 each call for a Source carries a ticket (Family, Source, short expiry, signed with a key the core shares with the proxies) in the proxy URL it hands the plugin; the proxy refuses a connection without one (407) and allows only the host fields of that one Source, which the core reads from that Source's Family, so that one stateless plugin can serve several Families. A missing or failed proxy means no internet at all.

## Considered Options

- **Plugins as packages loaded into the core process** with a TypeScript SDK: simplest, but every plugin sees every secret and runs with the core's privileges, and is bound to Node.js.
- **The worker starting containers** through the Docker socket or a socket proxy: dynamic, but root on the host.
- **Plugins calling the core**, or gRPC: a second direction to secure, or a toolchain every plugin author needs.
- **A contract rule against outbound access** without a proxy: nothing would enforce it.
