# Family Butler

Gathers family-relevant information from many channels into one overview of who has to be where, when, with what.

## Language

### People

**Family**:
The household the system serves; the unit that owns all Sources and Items.
_Avoid_: Account, tenant, user group

**Family Member**:
A person in the Family whom Items can concern, child or adult.
_Avoid_: User, profile, kid

### Inputs

**Source**:
A channel information arrives through, such as a timetable service, a calendar, a mailbox, or a messenger group.
_Avoid_: Channel, integration, feed, connector

### Items

**Item**:
Any single piece of family-relevant information extracted from a Source; one of Event, Lesson, Timetable Change, Task, or Notice.
_Avoid_: Entry, record, info

**Event**:
A one-off or recurring appointment with a time and usually a place, such as a piano lesson or a sports match.
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

**Task**:
Something a Family Member or parent must do or bring, optionally with a Deadline; a packing list is a Task with items to bring.
_Avoid_: Todo, action item, packing list (as a separate type)

**Deadline**:
The date by which a Task must be done; an attribute of a Task, not an Item of its own.
_Avoid_: Due date, Frist

**Notice**:
Information worth knowing that carries no time slot and nothing to do.
_Avoid_: Message, info, announcement
