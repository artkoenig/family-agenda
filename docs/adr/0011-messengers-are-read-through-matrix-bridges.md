---
status: proposed
---

# Messengers are read through Matrix bridges, behind one Matrix Source Type

Family Butler has no WhatsApp integration of its own. Every Messenger, WhatsApp included, is read through a Matrix bridge that runs on the Instance, next to a homeserver of its own, and there is one Source plugin for all of them: `source-matrix`. The Matrix plugin keeps a catalogue of the Messengers it supports, each served by one bridge, and an Admin picks from it the Messengers the Family uses. We chose this because Families use more than one Messenger (WhatsApp for the school class, Signal for the club, Telegram for the choir), and with a bridge per Messenger each new one costs one container, not one more client of our own to write, run and keep up with protocol changes. The bridges are maintained upstream, mostly by the mautrix project, and already solve login, media download, history backfill and reconnection.

## How it fits together

- **Homeserver**: the Matrix Compose profile runs Synapse, serving only the Instance. Federation and public registration are off, and it is reachable only on the Instance's internal network, never through Remote Access (ADR-0004). Synapse keeps its data in a database of its own on the Instance's Postgres server, separate from Family Butler's database, and its media in its own volume. We chose Synapse because the mautrix bridges are developed and tested against it, and a bridge that misbehaves on a less common homeserver would break a Source in ways we cannot fix.
- **Messengers are installed as bridges**: each Messenger in the catalogue has its own Compose profile that starts its bridge, such as `mautrix-whatsapp`, `mautrix-signal` or `mautrix-telegram`, with a configuration and an application service registration that the Matrix profile generates. An operator installs a Messenger by enabling its profile. The plugin finds the installed bridges at startup and lists the others in the catalogue as not installed.
- **Messengers are enabled by an Admin**: installed is not enabled, as for Source Types (ADR-0010). An Admin enables each installed Messenger in the Matrix plugin's settings, and only enabled Messengers are offered when adding a Matrix Source. A Messenger carries a risk notice where one applies, such as WhatsApp's (below), which needs its acknowledgement before it can be enabled. A new Messenger brought by an update stays disabled, and a Messenger can be disabled only while no Source uses it.
- **One Source per linked account**: a Matrix Source is one Messenger account linked through its bridge, such as a parent's WhatsApp. The plugin gives each Source a Matrix user of its own on the homeserver and keeps its access token in the `SecretStore`. The wizard's setup step drives the bridge's login for that user through the bridge's provisioning API: a QR code to scan for WhatsApp and Signal, a phone number and code for Telegram.
- **Ingestion**: the plugin polls. Each run is a Matrix `/sync` of the Source's user from the sync token in its state blob (ADR-0010). The homeserver holds everything that arrived in between, so a stopped worker loses nothing, and history the bridge backfills arrives the same way.
- **Origins**: the plugin turns each message in an allow-listed room into an Origin with a raw message, text and attachments, for the extraction pipeline. Rooms that are not allow-listed never become Origins. A redaction becomes the deletion of the message's Origin (ADR-0009). The Origin attributes are Messenger, chat and sender, so an Attribution Rule can match a WhatsApp group and a Signal group alike.
- **Health**: the plugin reads the bridge's state for the Source's login. A logged-out account, such as a WhatsApp device unlinked after the phone was unused for 14 days, is a definite error, and the Fix button runs the login again.

## Receive only

The rules of ADR-0001 apply to every Messenger. The bridges are configured not to send presence, typing notifications or read receipts, and the plugin's Matrix users never post in a bridged room, mark one read or accept an invitation that is not from their own bridge. The bridges still talk to their Messengers as a linked device of the Family's account. For WhatsApp, `mautrix-whatsapp` is whatsmeow as a linked device, which breaks WhatsApp's terms of service and puts the linked account at risk of a ban, exactly as ADR-0001 accepted; the Matrix plugin carries that risk notice for WhatsApp. Email forwarding remains the compliant fallback.

## Consequences

- There is no Go code in this repository any more. The bridges are third-party containers that the plugin talks to only through the homeserver and the bridges' provisioning APIs.
- A Family using only email, WebUntis and calendars runs no homeserver and no bridge. The Matrix profile and each bridge's profile are opt-in.
- Adding a Messenger the mautrix project or anyone else bridges is an entry in the plugin's catalogue and a Compose profile, not a new Source Type. A Messenger that needs extraction behaviour of its own would still be its own Source plugin.
- Synapse and the bridges store messages of every chat of a linked account, not only of the allow-listed ones. Their message retention follows the Instance's retention ([artkoenig/family-buttler#18](https://github.com/artkoenig/family-buttler/issues/18)), through Synapse's retention policy and the bridges' own settings.
- The bridges hold the Messenger sessions. They keep them in SQLite in their own volumes, outside Postgres, so no Messenger credential lands in a Postgres dump (ADR-0006). Synapse's database does hold the access tokens of the plugin's Matrix users in clear text; they only grant access to the homeserver, which is unreachable from outside the Instance. A backup adds Synapse's database dump and the Synapse and bridge volumes, under the same recovery kit.
- The Instance runs one more server and one container per Messenger. Bridges with no login are idle, but Synapse needs a few hundred megabytes of memory as soon as the Matrix profile is on, which is noticeable on a Raspberry Pi.
- Bridge and homeserver upgrades come from upstream images. A bridge that breaks after a Messenger protocol change is fixed upstream, and the Instance pins image versions it has been tested with.
- Like every Source, the homeserver and the bridges are bound by ADR-0004: they run on the Instance, never in Butler Cloud.

## Considered Options

- **A WhatsApp Source plugin with its own whatsmeow sidecar** (ADR-0001): one container less for WhatsApp alone, but every further Messenger would need a client of our own, and Go code in the repository.
- **One Source Type per bridged Messenger** (`source-whatsapp`, `source-signal`, ... each over Matrix): every Messenger would be enabled on its own like any Source Type, but they would share the homeserver and nearly all of their code, and the catalogue of bridges would be spread over several plugins.
- **A lighter homeserver from the Conduit family**: a single binary with embedded storage that fits a Raspberry Pi better, but the bridges are not developed against it, and their behaviour on it is less proven.
- **Synapse with SQLite**: no database on the Postgres server, but Synapse supports SQLite only for testing.
- **Only an existing homeserver of the operator**: no homeserver to ship, but few Families run one, and a public homeserver would hold the Family's and third parties' messages outside the Instance.
- **Bridges started from the Admin area through the Docker socket**: Messengers installed with one click, but the `api` process would control the host's Docker daemon. Operators enable Compose profiles instead, as for the rest of the Instance.
