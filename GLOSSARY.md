# Family Agenda

Gathers family-relevant information from many channels into one overview of who has to be where, when, with what.

## Language

### People

**Family**:
The household the system serves, owning all Sources and Items; each Instance serves exactly one.
_Avoid_: Account, tenant, user group

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
A parent who signs in with their own account, by password or through the Identity Provider, to manage settings and Sources, and to delete Items that should not be there. One who signs in only through the Identity Provider has no password until another Admin or the CLI sets one.
_Avoid_: Owner, superuser, parent account

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

**Plugin Host**:
The service that runs every Source plugin, installed from the Plugin Repository, each in an isolated process without access to the database, the master key or the blobs.
_Avoid_: sandbox, plugin server

**Source Status**:
Whether a Source works: **OK**; **Failing** when it needs an Admin, at once on a definite error and after 6 hours of temporary ones; or **Silent** when a Source Type that declares it has brought no new Source Record for 14 days.
_Avoid_: Health state, broken, stale (for the status)

**Messenger**:
A chat network, such as WhatsApp, Signal or Telegram, that the Matrix Source Type can read; each Source of that type is one linked Messenger account.
_Avoid_: Bridge (for the domain concept), network, chat app

**Catalogue**:
The entries a Source Type offers for an Admin to enable one by one, such as the Messengers of the Matrix Source Type.
_Avoid_: Option list, sub-type

**Source Record**:
One thing a Source delivered that Items come from: a message, such as a mail or a WhatsApp message, or an entry the Source states itself, such as a calendar entry or a Lesson. Each Item has exactly one Source Record.
_Avoid_: Source message, provenance

**Withdrawn**:
Said of a Source Record its Source no longer has, such as a deleted message or calendar entry; it backs no Items.
_Avoid_: Deleted, revoked, removed

**Sync Cursor**:
Where a Source resumes reading on its next run, such as the last mail read in each folder or a calendar's version; only its Source Type understands it, and it never moves past the Source Records kept.
_Avoid_: State, state blob, sync token, checkpoint

**Extraction**:
The one reading of a message by the LLM that finds its Items; a message edited later keeps what it found.
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
Something a Family Member or parent must do or bring, optionally with a Deadline; a packing list is one Task with things to bring.
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

**Instance**:
One installation of Family Agenda with its own database, serving exactly one Family.
_Avoid_: Server, deployment, tenant

**Recovery Kit**:
What an Admin prints or saves at first start to recover the Instance; without it, a backup cannot restore Source credentials.
_Avoid_: Recovery key, master key (for the document), backup code

**Single sign-on**:
Signing in as an Admin through the Identity Provider instead of the password. Offered only at the public base URL; the Family Agenda session that follows is its own.
_Avoid_: SSO login, passkey login

**Identity Provider**:
The OIDC server, such as Pocket ID, that an Admin may sign in through instead of a password. Only members of its required group may.
_Avoid_: SSO server, login provider

**Agenda Link**:
A secret, revocable link that opens one Agenda from outside the home network.
_Avoid_: Share link, token, magic link
