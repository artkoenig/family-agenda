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

**Family Member**:
A person in the Family whom Items can concern, child or adult.
_Avoid_: User, profile, kid

**Admin**:
A parent who signs in with their own account to manage settings and Sources, and to correct Items.
_Avoid_: Owner, superuser, parent account

**Agenda**:
A configurable perspective on the Family's Items, such as one showing only Items that concern a given Family Member, either as a timeline of days or as a Task List; opened without signing in, and read-only except for ticking Tasks done.
_Avoid_: View, dashboard, read-only user, kiosk

**Task List**:
An Agenda that lists the Tasks it shows instead of a timeline: Due and Overdue ones first, then those not Due yet, then those done in the last 30 days; ticked there as in a timeline.
_Avoid_: To-do view, task page, Tasks section

### Inputs

**Source**:
A channel information arrives through, such as a timetable service, a calendar, a mailbox, or a messenger group.
_Avoid_: Channel, integration, feed, connector

**Source Type**:
The kind of channel a Source is, such as WebUntis, an ICS calendar, an IMAP mailbox or Matrix; each is provided by a plugin, and a Family can have several Sources of one type.
_Avoid_: Source kind, provider, plugin (for the domain concept)

**Source Status**:
Whether a Source works: **OK**; **Failing** when it needs an Admin, at once on a definite error and after 6 hours of temporary ones; or **Silent** when a Source Type that declares it has brought no new Origin for 14 days.
_Avoid_: Health state, broken, stale (for the status)

**Messenger**:
A chat network, such as WhatsApp, Signal or Telegram, that the Matrix Source Type reads through a bridge on the Instance; an Admin enables each one, and each Source of the Matrix type is one linked Messenger account.
_Avoid_: Bridge (for the domain concept), network, chat app

**Catalogue**:
What a Source Type offers for an Admin to enable entry by entry, such as the Messengers of the Matrix Source Type; each Source of that type uses one enabled entry.
_Avoid_: Option list, sub-type

**Part**:
A named piece of a Source that an Admin lists in its settings and assigns on its own, such as one folder of an IMAP mailbox; each Origin of such a Source names the Part it came from. A mail found in several folders, such as under several Gmail labels, belongs to the first one read. Removing a Part from the settings drops its assignment, and its past Items then concern whom the Source does.
_Avoid_: Folder (for the domain concept), channel, sub-source

**Source Assignment**:
The Family Members an Admin assigns a Source to; the Source's Items concern them, or the whole Family when it is assigned to no one. A Source with Parts, such as the folders of a mailbox, is assigned Part by Part instead: an Item concerns the Family Members its Origin's Part is assigned to, falling back to those the Source is assigned to. Nothing else within a Source, such as a sender or a calendar's name, counts, and never what the content mentions. An Item from several Sources or Parts concerns everyone they are assigned to, or the whole Family if one of them is assigned to no one.
_Avoid_: Attribution Rule (replaced), mapping, routing rule, filter

### Items

**Origin**:
One appearance of an Item in a Source, such as a mail, a WhatsApp message or a calendar entry, that the Item was extracted from or updated by.
_Avoid_: Source message, provenance

**Revision**:
One statement about an Item from an Origin or an Admin that creates, changes, moves or cancels it; an Item is what its accepted Revisions add up to.
_Avoid_: Event, change, update, edit

**Re-reading**:
Having messages, of one Source or of all, extracted again with the current prompt and model, such as after the prompt improved. What a message states then supersedes what it stated before; the superseded Revisions stay recorded but no longer count, as if they had never arrived. Until a message is read again, what it stated before stays.
_Avoid_: Re-import, refresh, reprocess

**Item**:
Any single piece of family-relevant information extracted from a Source; one of Event, Lesson, Timetable Change, Task, or Notice.
_Avoid_: Entry, record, info

**Event**:
A one-off or recurring appointment with a time and usually a place, such as a piano lesson or a sports match; also a whole day without school, such as a study day, or what takes place at school, such as a bike check.
_Avoid_: Appointment, date, meeting

**Timetable**:
The regular school schedule of a Family Member, made up of Lessons.
_Avoid_: Schedule, plan

**Lesson**:
One slot of a Timetable: a subject at a time, in a room, with a teacher.
_Avoid_: Class, period

**Timetable Change**:
A deviation from the Timetable for a specific date, such as a cancellation or substitution.
_Avoid_: Substitution, update

**School Day**:
The Lessons of a Family Member on one date, which an Agenda shows as one row until the last Lesson that takes place, and a feed as one all-day entry; not an Item of its own.
_Avoid_: School row, school entry

**Task**:
Something a Family Member or parent must do or bring, optionally with a Deadline; a packing list is a Task with items to bring.
_Avoid_: Todo, action item, packing list (as a separate type)

**Deadline**:
The date by which a Task must be done, the month's last day when a message names only a month; an attribute of a Task, not an Item of its own.
_Avoid_: Due date, Frist

**Due**:
A Task not yet done from its Deadline day on, or from when it arrives if it has none; a Due Task is pinned at the top of every Agenda until someone ticks it done.
_Avoid_: Open, pending, active

**Overdue**:
A Task not yet done after its Deadline day; it stays pinned, marked overdue, as nothing completes a Task but a tick.
_Avoid_: Late, expired, missed

**Notice**:
Information worth knowing that carries no time slot and nothing to do.
_Avoid_: Message, info, announcement

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
