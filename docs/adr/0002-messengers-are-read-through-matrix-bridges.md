---
status: proposed
---

# Messengers are read through Matrix bridges, behind one singleton Matrix plugin

Family Agenda has no integration of its own for any Messenger. Every Messenger, WhatsApp included, is read through a Matrix bridge, and one Source Type, the Matrix plugin, covers them all. The Family wants Items from the groups it already belongs to without forwarding by hand, which the official APIs do not allow. Bridges such as `mautrix-whatsapp` link as a device to a Family member's own account. This breaks some Messengers' terms of service and puts that account at risk, which the Admin accepts when setting up a Messenger. One bridge per Messenger behind one plugin means a new Messenger costs a bridge, not a new Source Type.

- **Singleton**: the Matrix plugin holds state (Messenger sessions), so it runs as exactly one replica per Instance (ADR-0001).
- **Companion containers**: Synapse and one container per bridge, from upstream images, are declared with the plugin and reachable only on a network private to it. The core talks only to the plugin. Each companion has its own egress hosts.
- **State**: Synapse's media and the bridges' sessions live in volumes of their companions. Synapse's database is a role and database of its own on the Instance's Postgres server, created by an init script, so no container holds a URL that can create roles.
- **Which Messengers exist** is the deployment's choice of bridges. Federation and public registration are off.
- **Removal**: removing a Source logs its Messenger session out. Disabling the Source Type sends no calls and keeps the state. Wiping it means removing the volumes.

## Considered Options

- **A dedicated client per Messenger** (e.g. whatsmeow for WhatsApp): carries the same terms-of-service risk, and every Messenger needs its own code and Source Type.
- **Forwarding only**: compliant, but manual for every message, and the group context is lost.
