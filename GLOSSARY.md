# Family Agenda

Gathers family-relevant information from many channels into one overview of who has to be where, when, with what.

## Language

### People

**Family**:
The household the system serves; the unit that owns all Sources and Items. Each Instance serves exactly one, so the data never names it.
_Avoid_: Account, tenant, user group

**Family Language**:
The language the Instance speaks to the Family in and formats dates in, English or German; an Admin chooses it when setting up the Instance and can change it in the settings.
_Avoid_: Locale, UI language, region

**Theme**:
How the pages look in one browser: as the device prefers, light or dark. Each device chooses its own; the Instance does not know it.
_Avoid_: Skin, mode

**Family Member**:
A person in the Family whom Items can concern, child or adult.
_Avoid_: User, profile, kid

**Admin**:
A parent who signs in with their own account to manage settings and Sources, and to delete Items that should not be there.
_Avoid_: Owner, superuser, parent account

**Agenda**:
A configurable perspective on the Family's Items, as a timeline of days or as a Task List, for chosen Family Members or for the whole Family; opened without signing in, and read-only except for ticking Tasks done. One for chosen Family Members shows only the Items that concern at least one of them, not those that concern the whole Family; one for the whole Family shows every Item.
_Avoid_: View, dashboard, read-only user, kiosk

**Task List**:
An Agenda that lists only Tasks instead of a timeline: Due and Overdue ones first, then those not Due yet, then those done in the last 30 days; ticked there as in a timeline.
_Avoid_: To-do view, task page, Tasks section

**Quick Filter**:
A choice among an Agenda's Family Members made while looking at it, narrowing it to those members by the Agenda's own rule; it is not kept.
_Avoid_: Preselection, member filter, tab

### Inputs

**Source**:
A channel information arrives through, such as a timetable service, a calendar, a mailbox, or a Messenger account.
_Avoid_: Channel, integration, feed, connector

**Source Type**:
The kind of channel a Source is, such as WebUntis, an ICS calendar, an IMAP mailbox or Matrix; each is provided by a plugin, and a Family can have several Sources of one type.
_Avoid_: Source kind, provider, plugin (for the domain concept)

**Source Attribute**:
A subdivision of a Source that the Source itself reports, such as a mailbox folder or label, a WhatsApp group, a child in a timetable account, or the one calendar of an ICS Source; every Source has at least one, and only those an Admin chose to read count. A Source Attribute the Source no longer knows is archived and keeps its Source Assignment.
_Avoid_: Part, folder (for the domain concept), channel, sub-source, label

**Source Assignment**:
The Family Members an Admin assigns a Source Attribute to, and so the only thing that decides whom an Item concerns, never a sender or whom the content mentions. An Item concerns everyone its Origin's Source Attributes are assigned to, or the whole Family if one of them is assigned to no one.
_Avoid_: Attribution Rule, mapping, routing rule, filter

**Source Status**:
Whether a Source works: **OK**; **Failing** when it needs an Admin, at once on a definite error and after 6 hours of temporary ones; or **Silent** when a Source Type that declares it has brought no new Origin for 14 days.
_Avoid_: Health state, broken, stale (for the status)

**Source Warning**:
A problem shown beside a Source Status without changing it, such as an Origin naming a Source Attribute its Source never reported, or a calendar entry that cannot become an Item.
_Avoid_: Fourth status, error, alert

**Messenger**:
A chat network, such as WhatsApp, Signal or Telegram, that the Matrix Source Type reads through a bridge on the Instance; an Admin enables each one, and each Source of the Matrix type is one linked Messenger account.
_Avoid_: Bridge (for the domain concept), network, chat app

**Catalogue**:
What a Source Type offers for an Admin to enable entry by entry, such as the Messengers of the Matrix Source Type; each Source of that type uses one enabled entry.
_Avoid_: Option list, sub-type

### Items

**Origin**:
One thing a Source delivered that Items come from: a message, such as a mail or a WhatsApp message, or an entry the Source states itself, such as a calendar entry or a Lesson of a timetable. Each Item has exactly one Origin.
_Avoid_: Source message, provenance

**Withdrawn**:
Said of an Origin its Source no longer has, such as a deleted message or calendar entry; its Items are gone. A calendar entry or Lesson that comes back brings its Item back, a message does not.
_Avoid_: Deleted, revoked, removed

**Extraction**:
Reading a message with the LLM to find its Items, done once per message; a message edited later keeps what its first reading found.
_Avoid_: Parsing, re-import, reprocessing

**Automatic Check**:
A test an Item found by Extraction must pass to be written, such as its stated weekday matching its date; when one fails, the message is read once more, and an Item failing again is left out.
_Avoid_: Validation, confidence

**Not extracted**:
Said of a message whose Extraction keeps failing on its own content; an Admin can retry it while its content is kept.
_Avoid_: Failed, broken, unread

**Retention Period**:
How long the Instance keeps a message's content, about half a year from its arrival, or less once none of its Items needs it any more. Older messages are not taken in.
_Avoid_: Archive time, expiry, TTL

**Item**:
Any single piece of family-relevant information that came from an Origin; one of Event, Lesson or Task.
_Avoid_: Entry, record, info

**Event**:
A one-off appointment at a time or over whole days, usually with a place, such as a piano lesson, a sports match, a study day without school, or a bike check at school. A cancelled Event stays shown, struck through.
_Avoid_: Appointment, date, meeting

**Timetable**:
The regular school schedule of a Family Member, made up of Lessons.
_Avoid_: Schedule, plan

**Lesson**:
One slot of a Timetable on a date: a subject at a time, in a room, with a teacher.
_Avoid_: Class, period

**Lesson Change**:
How a Lesson deviates from the Timetable: cancelled, held by a substitute, or moved to another room; shown on the Lesson with what it replaces, not as an Item of its own.
_Avoid_: Timetable Change, substitution (for the concept), update

**School Day**:
The Lessons of a Family Member on one date, which an Agenda shows as one row until the last Lesson that takes place, and a feed as one all-day entry; not an Item of its own.
_Avoid_: School row, school entry

**Task**:
Something a Family Member or parent must do or bring, optionally with a Deadline; a packing list is a Task with things to bring, ticked done together. A cancelled Task stays pinned, struck through, until someone ticks it.
_Avoid_: Todo, action item, packing list (as a separate type)

**Deadline**:
The date by which a Task must be done, the month's last day when a message names only a month; an attribute of a Task, not an Item of its own.
_Avoid_: Due date, Frist

**Due**:
A Task not yet done from its Deadline day on, or from when it arrives if it has none; a Due Task is pinned at the top of every Agenda that shows it until someone ticks it done.
_Avoid_: Open, pending, active

**Overdue**:
A Task not yet done after its Deadline day; it stays pinned, marked overdue, as nothing completes a Task but a tick.
_Avoid_: Late, expired, missed

### Operation

**Instance**:
One installation of Family Agenda with its own database, serving exactly one Family.
_Avoid_: Server, deployment, tenant

**Agenda Cloud**:
The paid services an Instance can subscribe to, such as Remote Access, push notifications, a hosted LLM endpoint and off-site backups; never a place where Items live.
_Avoid_: Hosted version, SaaS, cloud edition

**Remote Access**:
Reaching an Instance from outside the home network through Agenda Cloud.
_Avoid_: Tunnel, relay, external access

**Recovery Kit**:
What an Admin prints or saves at first start to recover the Instance's master key: without it, a Backup cannot restore Source credentials; Backups to Agenda Cloud are encrypted with a key derived from it.
_Avoid_: Recovery key, master key (for the document), backup code

**Agenda Link**:
A secret, revocable URL that opens one Agenda from outside the home network.
_Avoid_: Share link, token, magic link
