# WhatsApp groups are read through an unofficial linked-device client

The official WhatsApp Cloud API cannot read groups the Family already belongs to, and the Family wants WhatsApp Items without manual forwarding. So v1 reads WhatsApp through whatsmeow, linked as a device to an Admin's personal account. This breaks WhatsApp's terms of service and puts that account at risk of a ban. We accept the risk because the Source is opt-in, the Admin accepts the risk explicitly, and the client only receives: it never sends messages or read receipts. It reads only groups the Admin has allow-listed and sits behind a swappable adapter. Email forwarding remains the compliant fallback.

## Considered Options

- **Forwarding only** (to a mailbox or a Cloud API bot number): compliant, but manual for every message, and the group context is lost.
- **Matrix homeserver with the `mautrix-whatsapp` bridge**: carries the same risk, because the bridge is itself whatsmeow as a linked device, and adds a homeserver, a database and a bridge. It only pays off if more messengers are added.
- **A dedicated Family Agenda number**: limits a ban to that number, but every group would have to add it, which defeats automatic ingestion.

_Scoped by ADR-0004: the whatsmeow sidecar only ever runs on the self-hosted Instance. Agenda Cloud never runs a WhatsApp client, so the account risk stays with the Admin who links the device, on the Family's own connection._

_Superseded by ADR-0011: Family Agenda has no WhatsApp client of its own. WhatsApp is one Messenger of the Matrix Source Type, read through the `mautrix-whatsapp` bridge on the Instance. The risk accepted here and the receive-only rules still apply to it._
