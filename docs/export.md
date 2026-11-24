# Export

The Export is one ZIP file with all of the Family's Agendas, Items and stored files, for an Admin to take the data elsewhere. It is not a backup: it holds none of the Sources' credentials, and nothing can be restored from it. Backups are the operator's copies of the database and the blob directory (see [upgrading.md](upgrading.md)).

## Downloading it

An Admin opens Admin → Export (`/admin/export`) and clicks "Download export". The file comes from a stable address that other pages may link to:

```
<public address>/admin/export/download
```

`<public address>` is `PUBLIC_URL`, or the Context's `publicUrl` in supplied mode, path prefix included. Only a signed-in Admin of the Family gets the file; anyone else is sent to the sign-in page and gets no data. The response is `application/zip`, named `family-agenda-export-YYYY-MM-DD.zip` after the day it is made on, in the Family's time zone, with `Content-Disposition: attachment` and `Cache-Control: no-store`.

The ZIP is made while it is downloaded, file by file, and the attachments are read in chunks, so a large Family's Export does not need to fit in memory. Its files are stored, not compressed.

## What it holds

```
family.json
family-members/<family member id>.<jpg|png|webp|gif>
items.json
agendas/agenda-1/feed.ics
agendas/agenda-1/items.json
agendas/agenda-2/…
messages/<message id>/message.json
messages/<message id>/body.txt
messages/<message id>/attachments/<position>-<file name>
```

It holds no Source's configuration (no passwords, tokens or other secret attributes), no family key or master key, no Recovery Kit, no Agenda Link and no Invitation token. An Agenda's id is its Agenda Link (ADR-0004), so the Export never names one: the Agendas are numbered `agenda-1`, `agenda-2` and so on, in the order the Admin area lists them.

All JSON files are UTF-8, instants are ISO 8601 in UTC (`2026-09-16T15:00:00.000Z`), dates are `YYYY-MM-DD`. Ids are UUIDs, and the same id means the same thing in every file of the Export.

### `family.json`

```json
{
  "format": "family-agenda-export",
  "version": 1,
  "exportedAt": "2026-09-14T07:00:00.000Z",
  "timeZone": "Europe/Berlin",
  "familyMembers": [{ "id": "…", "name": "Mia", "colour": "…", "avatar": "…", "photo": "family-members/….png" }],
  "agendas": [{ "folder": "agendas/agenda-1", "layout": "…", "memberIds": ["…"], "horizonDays": 14 }],
  "sources": [{ "id": "…", "sourceTypeId": "…", "name": "School mail", "shown": true }]
}
```

- `version` is raised when a field changes its meaning or goes away; a new field does not raise it.
- `familyMembers[].photo` is the path of the Family Member's photo in the ZIP, or null without one.
- `agendas[].memberIds` are the Family Members the Agenda shows, `folder` holds its files.
- `sources[]` are the Family's Sources, with `shown` false for a hidden one.

### `items.json`

All of the Family's Items, also those no Agenda shows now, such as past ones or those of a hidden Source. Each Item:

| Field | Meaning |
| --- | --- |
| `id` | The Item's id. |
| `kind` | `event`, `task` or `lesson`. |
| `event` | For an Event: `title`, `span` (`{ "allDay": false, "start", "end" }` with instants, or `{ "allDay": true, "firstDay", "lastDay" }` with dates), `place` (text or null), `cancelled`. |
| `task` | For a Task: `title`, `deadline` (a date or null), `description` (text or null; a line starting with `- ` is an entry of a list), `doneAt` (an instant or null), `arrivedAt` (an instant or null), `cancelled`. |
| `lesson`, `change` | For a Lesson: `lesson` with `subject`, `span` (`{ "start", "end" }`), `room`, `teacher`, `cancelled`; `change` its Timetable Change on that date or null, with `change` (`cancellation`, `substitution` or `room-change`), `subject`, `span`, `room`, `teacher`, `previousRoom`, `previousTeacher`, `note`. |
| `concerns` | Whom it concerns: a list of Family Member ids, or `"whole-family"`. |
| `links` | Where its Source Record can be looked at: `url`, `sourceTypeId`, `sourceName`. |
| `messages` | The messages it was extracted from: `id` (a folder under `messages/`), `sourceTypeId`, `sourceName`, `sentAt`. |

### `agendas/agenda-N/`

- `feed.ics` is the Agenda's feed as iCalendar, written by the same code as its live feed, for the same window, but without the Agenda Link (no `URL` and no link in the descriptions).
- `items.json` holds the Items of that feed, in the format of `items.json`.

### `messages/<message id>/`

One folder per message the Family keeps, with the messages whose content retention purged among them.

`message.json`:

| Field | Meaning |
| --- | --- |
| `id`, `sourceId` | The message, and the Source it came from (in `family.json`). |
| `sentAt`, `sender`, `subject` | As received; `sender` and `subject` may be null. |
| `attributes` | The names of its Source Attributes. |
| `purgedAt` | When its content was deleted after the retention period; null while it is kept. A purged message has no body and no attachment files. |
| `body` | `"body.txt"`, the file in this folder that holds its text, or null without one. |
| `attachments` | Each with `position`, `filename` (as sent), `contentType`, `size` in bytes, and `file`: its path in this folder, or null once it is purged. |
| `itemIds` | The Items extracted from it (in `items.json`). |

An attachment's file is named `attachments/<position>-<file name>`, the file name as sent with the characters that some systems refuse (`/ \ : * ? " < > |` and control characters) replaced by `_`, leading dots removed, and cut to its last 100 characters. The position keeps two attachments of the same name apart; `filename` in `message.json` keeps the name as sent.
