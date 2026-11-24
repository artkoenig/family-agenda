# Family Agenda

Gathers family-relevant information from many channels into one overview of who has to be where, when, with what.

## Language

### People

**Family**:
The household the system serves, owning all Sources and Items; each Instance in fixed mode serves exactly one, and a core in supplied mode serves the one whose Context a request carries.
_Avoid_: Account, tenant, user group

**Family id**:
The one identifier of a Family, a UUID written when the Family is first prepared, the one the operator chose or a random one; it names the Family outside its database, such as in a Ticket. It never changes afterwards.
_Avoid_: Public id, tenant id

**Family Language**:
The language, English or German, in which the Instance speaks to the Family and formats dates; chosen by an Admin.
_Avoid_: Locale, UI language, region

**Theme**:
How the pages look on one device: as the device prefers, light or dark; each device chooses its own.
_Avoid_: Skin, mode

**Family Member**:
A person in the Family whom Items can concern, child or adult.
_Avoid_: User, profile, kid

**Admin**:
A parent who signs in through the Identity Provider to manage settings and Sources, and to delete Items that should not be there. The Identity Provider alone decides who is one: by its required role or group in fixed mode, by the Family id it names in supplied mode, where each Admin belongs to exactly one Family. With a Management API, membership in the Family's Organization decides instead, named by the ID token's organizations claim, in either mode. The core keeps no accounts and no passwords.
_Avoid_: Owner, superuser, parent account

**Organization**:
The Family's counterpart in the Identity Provider, created by its Registration; its members are the Family's Admins. Only with a Management API.
_Avoid_: Tenant, group, team

**Registration**:
A parent signing up at the Identity Provider, which creates a new Family with them as its first Admin. Self-hosted, only the first one does; registration then closes, and further Admins join by Invitation. Only with a Management API.
_Avoid_: Sign-up form, onboarding

**Invitation**:
A pending invite, sent by an Admin by email through the Identity Provider, to become an Admin of the Family; listed and revocable on the Admins page, it expires after 7 days. Accepting it creates no Family.
_Avoid_: Invite code, membership request

**Admins page**:
The page in the Admin area that lists the Family's Admins and pending Invitations, invites by email, revokes an Invitation and removes an Admin, never the last one. Only with a Management API.
_Avoid_: User management, members page

**Agenda**:
A perspective on the Family's Items, as a timeline of days or a Task List, opened without signing in and read-only except for ticking Tasks done. It is for chosen Family Members, showing only the Items that concern at least one of them, or for the whole Family, showing every Item.
_Avoid_: View, dashboard, read-only user, kiosk

**Task List**:
An Agenda showing only Tasks instead of a timeline: Due and Overdue ones first, then those not Due yet, then those done in the last 30 days.
_Avoid_: To-do view, task page, Tasks section

**Quick Filter**:
A passing choice among an Agenda's Family Members that narrows the Agenda to them while it is open.
_Avoid_: Member filter, tab

### Inputs

**Source**:
A channel information arrives through, such as a timetable service, a calendar, a mailbox or a Messenger account.
_Avoid_: Channel, integration, feed, connector

**Source Type**:
The kind of channel a Source is, such as WebUntis, an ICS calendar, an IMAP mailbox or Matrix; a Family can have several Sources of one type.
_Avoid_: Source kind, provider, plugin (for the domain concept)

**Source Attribute**:
A subdivision of a Source that the Source itself reports, such as a mailbox folder or label, a WhatsApp group, a child in a timetable account, or the one calendar of an ICS Source; only those an Admin chose to read count. An Admin assigns it to Family Members, and its Items concern them, or the whole Family if it is assigned to no one.
_Avoid_: Folder (for the domain concept), channel, sub-source, label

**Source Status**:
Whether a Source works: **OK**; **Failing** when it needs an Admin, at once on a definite error, after 6 hours of temporary ones, and while a message of it failed Extraction; or **Silent** when a Source Type that declares it has brought no new Source Record for 14 days.
_Avoid_: Health state, broken, stale (for the status)

**Messenger**:
A chat network, such as WhatsApp, Signal or Telegram, that the Matrix Source Type can read; each Source of that type is one linked Messenger account.
_Avoid_: Bridge (for the domain concept), network, chat app

**Catalogue**:
The entries a Source Type offers for an Admin to enable one by one, such as the Messengers of the Matrix Source Type.
_Avoid_: Option list, sub-type

**Source Record**:
One thing a Source delivered that Items come from: a message, such as a mail or a WhatsApp message, or an entry the Source states itself, such as a calendar entry or a Lesson. Each Item has exactly one Source Record, the first of its Copies if it has several.
_Avoid_: Source message, provenance

**Copy**:
One of the Source Records that are the same message, because several Sources of one Source Type received it, such as a mail to a mailing list in two mailboxes; they have the same external id. Only the first is read, and its Items concern everyone any Copy concerns.
_Avoid_: Duplicate, twin

**Withdrawn**:
Said of a Source Record its Source no longer has, such as a deleted message or calendar entry; it backs no Items.
_Avoid_: Deleted, revoked, removed

**Sync Cursor**:
Where a Source resumes reading on its next run, such as the last mail read in each folder or a calendar's version; only its Source Type understands it, and it never moves past the Source Records kept.
_Avoid_: State, state blob, sync token, checkpoint

**Extraction**:
The one reading of a message by the LLM that finds its Items; a message edited later keeps what it found. A message whose reading fails three times has failed, and waits for an Admin's retry.
_Avoid_: Parsing, re-import, reprocessing

### Items

**Item**:
A single piece of family-relevant information from a Source Record: an Event, a Lesson or a Task.
_Avoid_: Entry, record, info

**Event**:
A one-off appointment at a time or over whole days, usually with a place, such as a piano lesson, a sports match, a study day without school, or a bike check at school.
_Avoid_: Appointment, date, meeting

**Timetable**:
The regular school schedule of a Family Member, made up of Lessons.
_Avoid_: Schedule, plan

**Lesson**:
One slot of a Timetable on a date: a subject at a time, in a room, with a teacher; it may be cancelled, held by a substitute, or moved to another room.
_Avoid_: Class, period

**School Day**:
The Lessons of a Family Member on one date, shown together as one entry; not an Item of its own.
_Avoid_: School row, school entry

**Task**:
Something a Family Member or parent must do or bring, optionally with a Deadline and a description of what else to know; a packing list is one Task whose description lists the things to bring.
_Avoid_: Todo, action item, packing list (as a separate type)

**Deadline**:
The date by which a Task must be done, the month's last day when only a month is named; belongs to a Task, not an Item of its own.
_Avoid_: Due date, Frist

**Due**:
Said of a Task not yet done, from its Deadline day on, or from its arrival if it has none; pinned at the top of every Agenda that shows it until ticked done.
_Avoid_: Open, pending, active

**Overdue**:
Said of a Task not yet done after its Deadline day; it stays pinned until ticked done.
_Avoid_: Late, expired, missed

### Operation

**Context**:
What a core in supplied mode needs to open the Family one request is for: its Family id, its database, its family key and its blob location, and the setting that is the Family's own: its public address (the path prefix included), with an expiry at most a day ahead, encrypted and signed by a trusted caller in front with the Context key. It reaches the core only on the caller port; without a valid one the core refuses the request and opens nothing. It may also carry the Family's Organization id, a notice that every page shows in a thin banner at its top (with a link for a signed-in Admin), stored nowhere, and a starting time zone, stored only while the Family has none; afterwards Admins choose the time zone in the Admin area. It opens only a Family that is already prepared, and writes nothing but that Organization id, recorded while none is and refused when it differs, and the starting time zone while none is stored; only the Triggered operation that prepares the Family writes to its database, with the Context's Family id.
_Avoid_: Tenant context, session, family token

**Context key**:
The key a trusted caller and the cores in supplied mode share, and nobody else; Contexts are sealed and opened with a key derived from it.
_Avoid_: Shared secret, gateway key

**Family key**:
The key a Family's Source credentials are stored under, which a Context carries; in supplied mode it takes the place of the master key file of a fixed core.
_Avoid_: Tenant key

**Blob location**:
The blob directory a Context names; the Family's blobs lie in its folder there, `<blob location>/<Family id>`, so that Families can share one.
_Avoid_: Bucket, blob path

**Fixed mode**:
How a core runs by default: it serves the one Family its environment names, and reads no Context.
_Avoid_: Single-tenant mode

**Supplied mode**:
How a core runs with `CONTEXT_MODE=supplied`: it has no Family of its own and serves, on its caller port, the Family whose Context each request carries; any core can serve any Family, and one several.
_Avoid_: Multi-tenant mode, gateway mode

**Instance**:
One installation of Family Agenda with its own database, serving exactly one Family in fixed mode; in supplied mode its cores serve several Families, each in its own database, by the Context of each request.
_Avoid_: Server, deployment, tenant

**Due work**:
One run of the Family's background work: the Sources whose polling interval has passed, then Extraction of the messages they and earlier runs brought in. The `worker` runs it every minute; it is also a Triggered operation.
_Avoid_: Polling job, sync

**Preparing the Family**:
Bringing a Family's database up to date: migrating its schema, writing its Family id while it has none, moving blobs of the earlier layout into the Family's folder of the blob volume, recording the Source Types seen for the first time as disabled, and migrating the configuration of the Sources of enabled ones. The `api` and `worker` do it when they start, and a core in supplied mode when it opens a Family whose database this release has not prepared; running it again changes nothing.
_Avoid_: Bootstrap, setup, init

**Triggered operation**:
A piece of the `worker`'s work, such as Due work, the purge or the secret sweep that something outside the core runs on request through the `api`'s own unpublished port, with the Instance's trigger token, and in supplied mode with the Context of the Family it acts on. It runs the same code as the `worker`'s schedule or as the command line.
_Avoid_: Job, webhook, internal API

**Companion**:
A container a plugin needs beside its own, such as Synapse for the Matrix plugin, declared with the plugin in `plugins.yml`; reachable only on that plugin's network.
_Avoid_: Sidecar, plugin service

**Egress Proxy**:
The only way out to the internet for a plugin container or a Companion with egress hosts; it lets through only what that container's Allowlist names, and only to public addresses. A plugin's own proxy lets through only a call that presents a Ticket minted for that plugin, and decides from the Ticket and its own declared hosts alone, without asking the core.
_Avoid_: Firewall, gateway, sidecar

**Allowlist**:
The hosts one Egress Proxy lets through: those declared in `plugins.yml`, plus, for the plugin's own container, the values of Host Fields of the one Source its Ticket names, as the Ticket carries them. The plugin's proxy reads it from each Ticket and from the declared hosts in its own environment; a Companion's proxy has its declared hosts only.
_Avoid_: Whitelist, egress rules

**Ticket**:
What the core grants one call to a plugin: the Family, the Source the call is for with the values of its Host Fields as they are when the Ticket is minted (no Source and no hosts for the Catalogue entries, which reach the declared hosts only) and a short expiry, signed with a key the core shares with the Egress Proxies, for one plugin, whose proxy alone takes it. It comes with the call in the proxy URL, and the plugin presents it to its Egress Proxy on every connection; without a valid one for its plugin the proxy answers 407. A change to a Host Field reaches a call under way only when its Ticket expires.
_Avoid_: Token, egress token

**Host Field**:
A configuration field of a Source Type whose value is a host the plugin connects to, such as an IMAP server; its value joins the plugin's Allowlist. A pasted URL counts as its host: the scheme and everything from the first `/`, `?` or `#` are dropped. A secret field can be one too, such as a calendar address with a token in it: the core keeps its host in the clear, without user, password or path, as the Admin enters the value.
_Avoid_: Server field, URL field

**Path prefix**:
The path an Instance is served below, such as `/agenda`: the path of `PUBLIC_URL`, none without one. The proxy in front removes it; the Instance puts it on every address it emits.
_Avoid_: Base path, subpath

**Recovery Kit**:
What an Admin prints or saves after the first sign-in to recover the Instance; the Admin area shows it until an Admin confirms it was saved; without it, a backup cannot restore Source credentials.
_Avoid_: Recovery key, master key (for the document), backup code

**Export**:
The file an Admin downloads with all of the Family's Agendas, Items and stored files, without the Sources' credentials, to take the data elsewhere.
_Avoid_: Backup (the operator's copies), dump, download

**Single sign-on**:
Signing in as an Admin through the Identity Provider, the only way to sign in. The Family Agenda session that follows is its own and lasts 12 hours.
_Avoid_: SSO login, passkey login

**Identity Provider**:
The one OIDC server of a deployment that Admins sign in through, configured in the environment: the household's own, or the optional Logto container the stack ships. It holds the Admins, their passwords and their roles; with a Management API, also the Families' Organizations.
_Avoid_: SSO server, login provider

**Management API**:
The Identity Provider's optional management interface, set by the `IDP_MANAGEMENT_*` variables, that the core reaches through its `IdentityDirectory` port; it switches on Registration and the Admins page. Without it, Admins are managed in the Identity Provider itself.
_Avoid_: Admin API, IdP API

**Agenda Link**:
A secret, revocable link that opens one Agenda from outside the home network.
_Avoid_: Share link, token, magic link (a magic link signs someone in; an Agenda Link signs no one in)

**Invitation link**:
The link in the email inviting someone to become an Admin of a Family. It starts Single sign-on with a one-time token for the invitee's email, which verifies that email and lets someone without an account create one, even while registration is closed; it works once and expires with the invitation (ADR-0011).
_Avoid_: Magic link, invite code, accept link
