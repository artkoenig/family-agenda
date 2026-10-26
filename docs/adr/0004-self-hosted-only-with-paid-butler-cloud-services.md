---
status: proposed
---

# Self-hosted only, with paid Butler Cloud services for the Instance

Family Butler runs only as a self-hosted Instance that serves one Family. There will be no hosted multi-tenant version. The paid offering is Butler Cloud, a set of services an Instance can subscribe to, like Nabu Casa does for Home Assistant: Remote Access from outside the home network, push delivery of notifications, a hosted LLM endpoint, and encrypted off-site backups. We chose this over a multi-tenant SaaS because the Sources that make Family Butler useful cannot run in a provider's cloud. WhatsApp through whatsmeow (ADR-0001) and WebUntis through undocumented endpoints would mean the provider operating ToS-breaking clients for many accounts from data-centre IPs. Keeping Sources at home also keeps Family data, and third parties' raw messages, out of the provider's hands.

The Instance stays the whole product. Every Source, the extraction pipeline, the change list and the Views run on it, and it works completely without Butler Cloud. Each Butler Cloud service sits behind a port in `packages/application` with a self-hosted implementation next to it:

| Port | Without Butler Cloud | With Butler Cloud |
|---|---|---|
| Remote Access | none, or the operator's own VPN or reverse proxy | relay tunnel |
| `Notifier` | Telegram bot, SMTP, ntfy.sh | Butler Cloud push |
| `Extractor` | the Family's own OpenAI-compatible endpoint | Butler Cloud LLM endpoint |
| Backup target | a local path or the operator's own storage | Butler Cloud storage |

Which implementation is wired is decided in the composition root from configuration, never in domain or use-case code.

## Consequences

- The Instance opens only outbound connections to Butler Cloud. Remote Access is a tunnel the Instance dials out, so no port forwarding is needed.
- Remote Access keeps TLS end to end: the relay routes by SNI and never holds the Instance's certificate or sees Family data in clear text. The Instance gets a publicly trusted certificate for its Butler Cloud hostname, so with Remote Access it has a secure context.
- Backups are encrypted on the Instance with a key Butler Cloud never sees (see ADR-0006).
- The hosted LLM endpoint does receive the text of Family messages. The Admin must opt in to it explicitly, as with any cloud endpoint, and it needs a data processing agreement and EU hosting.
- Butler Cloud is a separate system with its own repository. Its accounts are per Instance subscription, not per Family Member, and it holds no Items.
- No Source ever runs in Butler Cloud. A Source that cannot run on the Instance is not a Source.

## Considered Options

- **Multi-tenant SaaS with Postgres row-level security**: the usual way to sell a hosted version. Rejected because WhatsApp and WebUntis would have to run in the provider's cloud, and because the provider would become the processor of every Family's and every third party's messages.
- **SaaS plus a local connector agent for the risky Sources**: keeps WhatsApp at home, but still needs the full multi-tenant system, tenant isolation, and a split pipeline across two places.

_Since ADR-0011 the WhatsApp client is Baileys instead of whatsmeow; the reasoning here is unchanged._
