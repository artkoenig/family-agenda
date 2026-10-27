# Calendar Source ingestion: secret ICS URL vs. Google Calendar API vs. CalDAV

Question (issue #4): how should Family Agenda read calendar **Sources** such as Google Calendar, and ideally iCloud and club calendars, read-only, to turn them into **Events**?

Research date: 2026-10-25. Note: Google, Apple and IETF hosts could not be fetched directly from the research sandbox. Google and RFC claims below come from search-engine extracts of the official pages linked. Library claims were read directly from GitHub sources. Items marked *unverified* need checking before implementation.

## The three options

| | Secret iCal (ICS) URL | Google Calendar API (OAuth) | CalDAV |
|---|---|---|---|
| What it is | A read-only HTTPS URL that returns the whole calendar as one RFC 5545 `.ics` file | REST API (`events.list`, etc.) returning JSON | WebDAV extension (RFC 4791); each event is an iCalendar resource |
| Auth | The URL is the secret (bearer-by-URL) | OAuth 2.0 with a Google Cloud project | Google: OAuth 2.0 only. iCloud: app-specific password. Others: usually Basic auth |
| Freshness | Bounded by our own poll interval. Google's export is generally reported to lag (third-party reports of up to ~24 h for consumers such as Outlook and Proton, though that is mostly the consumer's poll interval). *Unverified for direct polling* | Near-real-time: poll with a sync token every few minutes, or push via `events.watch` | Near-real-time: poll with `sync-collection` or ETags |
| Change detection | None in the format. At best HTTP `ETag`/`Last-Modified` on the whole file (*unverified for Google*); otherwise download and diff everything | `syncToken` / `nextSyncToken`; deletions always included; `410 Gone` means do a full resync | RFC 6578 `sync-collection` token plus per-resource `getetag` |
| Recurrence | We must expand RRULE/EXDATE/RDATE and `RECURRENCE-ID` overrides ourselves (library: `recurring-ical-events`) | `singleEvents=true` expands it server-side; exceptions carry `recurringEventId` and `originalStartTime` | Raw iCalendar like ICS (we expand), or a server-side `<C:expand>` in `calendar-query` |
| Generality | Highest: Google, iCloud public/shared calendars, Outlook "publish", nearly every club/school/league tool | Google only | Standard across iCloud, Fastmail, Nextcloud, Radicale, mailbox.org, Google. Club tools rarely offer it |
| Setup for one self-hosted Family | Paste a URL. No app registration | Create a GCP project, OAuth client, consent screen, redirect URI. Testing-mode tokens expire after 7 days | Per provider: Google needs the same OAuth setup as the API; iCloud needs an app-specific password |

## Findings

### 1. Secret iCal URL
- Google gives every calendar a "secret address in iCal format" under calendar settings. It is read-only and anyone holding the URL can read the calendar; Google lets you reset it to revoke access ([Google Calendar Help](https://support.google.com/calendar/answer/37648), [U-M KB on resetting the secret address](https://teamdynamix.umich.edu/TDClient/30/Portal/KB/Article/5618/Creating-a-New-Google-Calendar-Secret-Address)).
- The format (RFC 5545) is a full snapshot, with no change feed. Freshness complaints ("up to 24 h", "every 16 h") come from *subscribing clients'* poll intervals ([Proton](https://proton.me/support/sharing-link-google-calendar), [Church Social](https://help.churchsocial.com/article/45-ical-calendar)). Whether Google's export itself is cached/delayed when we poll it directly is *unverified*. Test it empirically.
- Recurrence: the feed has the master VEVENT with `RRULE`/`EXDATE` plus separate VEVENTs with `RECURRENCE-ID` for moved or cancelled occurrences. `recurring-ical-events` (Python, NLnet-funded) exists precisely because "Events ... can be repeated, removed from the feed and edited later on" ([GitHub](https://github.com/niccokunzmann/python-recurring-ical-events)).
- Change detection must be done by us: hash the file, then diff by `UID` + `RECURRENCE-ID` (+ `SEQUENCE`/`LAST-MODIFIED`). That is cheap for a family-sized calendar.

### 2. Google Calendar API
- Incremental sync: a full `events.list` returns `nextSyncToken` on its last page. Later calls pass `syncToken` and get only changes, and deleted events are always included (`showDeleted` cannot be false). The server may invalidate a token (expiry, ACL changes) and returns `410 Gone`, after which the client must wipe and do a full sync ([Sync guide](https://developers.google.com/workspace/calendar/api/guides/sync), [events.list](https://developers.google.com/calendar/v3/reference/events/list)).
- Recurrence: `singleEvents=true` expands series into instances server-side ([events.list](https://developers.google.com/calendar/v3/reference/events/list)). Exceptions are linked by `recurringEventId`/`originalStartTime` (Events resource; *details not re-fetched*).
- Push: `events.watch` needs a public HTTPS webhook with a valid, non-self-signed certificate ([Push notifications](https://developers.google.com/workspace/calendar/api/guides/push)). That is a poor fit for a home LAN install, so polling with sync tokens is the realistic mode.
- Setup friction:
  - Calendar read scopes are *sensitive*. An unverified app shows a warning screen and is capped at 100 users. Verification is not needed for "experimental or test builds" not launched publicly ([Unverified apps](https://support.google.com/cloud/answer/7454865)). One Family is far under the cap, so verification is not required, but the Admin must create their own GCP project (no shared Family Agenda client ID, because that would be a public app needing verification).
  - With publishing status **Testing**, refresh tokens expire after **7 days**. Moving to **In production** (still unverified) gives long-lived tokens that expire only if revoked or unused for ~6 months ([Google setup docs](https://developers.google.com/health/setup)).
  - Redirect URIs for web clients must be HTTPS, cannot be raw IPs and must use a public-suffix TLD. Only `localhost` is exempt ([Manage OAuth clients](https://support.google.com/cloud/answer/15549257)). A self-hosted box at `http://192.168.x.x` or `agenda.local` therefore cannot be a redirect target. Workarounds: authorise once via a desktop/loopback client (`http://localhost`) or a public domain with TLS. Whether the device-code flow permits Calendar scopes is *unverified* (Google's "allowed scopes" list for devices was not retrievable).
- Generality: Google only.

### 3. CalDAV
- Change detection is standardised: RFC 6578 `sync-collection` returns changed and deleted members since a token, with a full resync when the token has expired. Clients can also compare `DAV:getetag` via PROPFIND or `calendar-query` ([RFC 6578](https://www.rfc-editor.org/rfc/rfc6578), [RFC 4791](https://datatracker.ietf.org/doc/html/rfc4791), [CalConnect dev guide](https://devguide.calconnect.org/caldav/)).
- Google CalDAV (`https://apidata.googleusercontent.com/caldav/v2/{calendarId}/events`) **requires OAuth 2.0** and rejects Basic auth with 401. The old `www.google.com/calendar/dav` endpoint is deprecated ([Google CalDAV guide](https://developers.google.com/calendar/caldav/v2/guide)). So for Google, CalDAV has *all* of the OAuth friction of the REST API with fewer features.
- iCloud: `caldav.icloud.com` with Apple ID + app-specific password (2FA required). There is no official public doc beyond the password requirement ([Nylas iCloud guide](https://cli.nylas.com/guides/icloud-caldav-settings)). Apple's OAuth-style "Apple Account authorization" for third parties was still a pilot ([Apple Developer Forums](https://developer.apple.com/forums/thread/850313)). The `python-caldav` library ships an iCloud profile, and its measured compatibility hints (2026-10) show iCloud supports sync tokens (only the `limit` option is unsupported) and expands recurrences in searches ([python-caldav compatibility_hints.py](https://github.com/python-caldav/caldav/blob/master/caldav/compatibility_hints.py)). The library notes Google and iCloud "haven't been tested for a long time" ([python-caldav docs](https://github.com/python-caldav/caldav/blob/master/docs/source/about.rst)).
- Generality: good for "real" calendar servers (iCloud, Nextcloud, Fastmail, etc.), poor for club/school calendars, which almost always publish only an ICS link.

## Implications for Family Agenda

**Recommendation: make the ICS URL the baseline calendar Source type, and add Google API / CalDAV only as optional upgrades if latency proves to be a problem.**

1. **ICS-URL Source first.** It covers Google (secret address), iCloud (public/shared link), Outlook, and practically every club or school calendar with one code path and zero OAuth setup. The Admin pastes a URL. Poll every 5–15 min with conditional GET where supported, expand recurrences with a library such as `recurring-ical-events`, and diff by `UID`+`RECURRENCE-ID` to produce Event upserts and deletions. Treat the URL as a secret (store it like a credential; it is revocable at the provider).
2. **Measure Google's ICS lag before building OAuth.** If polling the secret address directly shows multi-hour staleness, add a **Google Calendar API Source** (`calendar.readonly` or `calendar.events.readonly`, `singleEvents=true`, sync-token polling, no push). Document the Admin setup: own GCP project, set to *In production* (unverified is fine for one Family), and one-time authorisation via a `localhost` loopback redirect or a public HTTPS hostname.
3. **CalDAV is not worth it for Google** (same OAuth burden as the API). It is worth adding later as a generic Source type for iCloud private calendars and self-hosted servers, using app-specific passwords and RFC 6578 sync tokens.
4. Whatever the transport, the Item model stays the same. Every calendar Source normalises to **Events** keyed by (Source, UID, RECURRENCE-ID), so transports can be swapped per Source without touching Views.
