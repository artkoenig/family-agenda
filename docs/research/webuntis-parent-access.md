# WebUntis Source: reading two children's data with one parent account

Question (issue #2): with one WebUntis parent account (2 children, 1 school), which APIs give programmatic access to each child's **Timetable**, **Timetable Changes** (cancellations, substitutions, room changes), homework/exams (**Tasks**) and school messages (**Notices**)? How does authentication work, what are the rate-limit and ToS risks, and which client libraries are maintained?

Research date: 2026-10-25. Note: `help.untis.at`, `untis.at` and school websites could not be fetched from the research sandbox. Claims about them come from search-engine extracts of the linked pages and are marked *(search extract)*. Library claims were read directly from the cloned source at the commits named below. Items marked *unverified* need checking against the real school account before implementation.

## Short answer

There is no official, documented API that a parent may use. Untis officially documents only (a) the legacy **JSON-RPC API** (spec PDF on request only) and (b) the partner-only **Untis Platform API** (OAuth client credentials, requires an integration partnership with the school). Every working parent integration uses **undocumented endpoints of the same WebUntis server the web and mobile apps use**:

1. **Mobile "2017" JSON-RPC** (`/WebUntis/jsonrpc_intern.do`, per-request TOTP from the "Untis Mobile" QR secret). `getUserData2017` returns the parent's `children` list. `getTimetable2017`, `getHomeWork2017`, `getExams2017`, `getStudentAbsences2017` and `getMessagesOfDay2017` are then called with `type: STUDENT` and a child's id. This is the most practical path for us.
2. **Web REST** (`/WebUntis/api/rest/view/v1/...`, session cookie, then a JWT from `/WebUntis/api/token/new`). `app/data` lists `user.students` (the children). `timetable/entries?resourceType=STUDENT&resources=<childId>` returns the richest Timetable Change data. `messages` returns the parent's inbox.
3. The **legacy public JSON-RPC** (`/WebUntis/jsonrpc.do`) also works for a parent if you pass the child's id with element type 5, but it returns thinner change data and is reportedly blocked for 2FA users.

So one parent login can cover both children: enumerate the children once, then loop over each child's id.

## Findings

### 1. Which APIs exist

| API | Endpoint | Documented? | Auth | Parent-usable? |
|---|---|---|---|---|
| Public JSON-RPC (2010s) | `POST /WebUntis/jsonrpc.do?school=<loginName>` | Spec PDF only on request from Untis. The `webuntis` npm author: "you need to email Untis directly and ask. I am (legally) not allowed to publish it." ([Readme](https://github.com/SchoolUtils/WebUntis/blob/master/Readme.md)) | `authenticate` with user + password, which yields a `JSESSIONID` | Yes, with the child's id and type 5. `getOwnTimetable*` fails with `invalid elementType: 12` because the parent person has type 12 ([HA integration config_flow](https://github.com/JonasJoKuJonas/homeassistant-WebUntis/blob/main/custom_components/webuntis/config_flow.py), [issue #139](https://github.com/JonasJoKuJonas/homeassistant-WebUntis/issues/139)) |
| Mobile "2017" JSON-RPC (used by Untis Mobile) | `POST /WebUntis/jsonrpc_intern.do?school=…` methods `*2017` | No | `auth: {user, otp, clientTime}` in **every** request; the OTP is a TOTP from the QR "secret" | Yes, this is what [toughIQ/webuntis-mcp](https://github.com/toughIQ/webuntis-mcp) does for parents |
| Web REST (used by the web UI and newer apps) | `/WebUntis/api/rest/view/v1/*`, `/v2/calendar-entry/detail`, `/api/homeworks/lessons`, `/api/exams`, `/api/classreg/absences/students` | No | Session cookie, then `GET /WebUntis/api/token/new` returns a JWT used as `Authorization: Bearer`; some servers also need a `tenant-id` header | Yes ([Naumsede/webuntis-home-assistant](https://github.com/Naumsede/webuntis-home-assistant), tested only with a legal-guardian account) |
| Untis Platform API | Partner API gateway, REST + OIDC/OAuth2 | Yes, for integration partners ([Untis help: API documentation for integration partners](https://help.untis.at/hc/de/articles/4886785534354-API-documentation-for-integration-partners) *(search extract)*) | OAuth client credentials issued for a partner integration ([Meow/webuntis-api README](https://github.com/Meow/webuntis-api) *(search extract)*) | No. It is school-side and not available to an individual parent |

### 2. Authentication details

- **School-specific server.** Every school lives on a host like `<something>.webuntis.com` and has a `loginName`. Both come from the public school search `https://schoolsearch.webuntis.com/schoolquery2` (`serverUrl`, `loginName`) ([webuntis-mcp setup.py](https://github.com/toughIQ/webuntis-mcp/blob/main/src/webuntis_mcp/setup.py)). The same values appear in the QR dialog.
- **Password login.**
  - JSON-RPC uses `authenticate` with `{user, password, client}` ([SchoolUtils/WebUntis `base.ts`](https://github.com/SchoolUtils/WebUntis/blob/master/src/base.ts)).
  - The web REST path uses `POST /WebUntis/j_spring_security_check` with `j_username`, `j_password`, `school` and a CSRF `token` scraped from the login page ([find_student_ids.py](https://github.com/Naumsede/webuntis-home-assistant/blob/main/scripts/find_student_ids.py)).
  - Sessions idle out after "less than 10min" ([base.ts doc comment](https://github.com/SchoolUtils/WebUntis/blob/master/src/base.ts)).
- **OTP / secret login (recommended).**
  - Where to find the secret: WebUntis → Profile → *Freigaben* → *Zugriff über Untis Mobile* shows a QR code with server, school, user and a 16-character **Schlüssel** (secret) ([webuntis-mcp README](https://github.com/toughIQ/webuntis-mcp)).
  - Request shape: each `jsonrpc_intern.do` call carries `{"auth": {"user", "otp": TOTP(secret), "clientTime": ms}}` ([webuntis-mcp auth.py/client.py](https://github.com/toughIQ/webuntis-mcp/tree/main/src/webuntis_mcp)).
  - It also gives a `JSESSIONID`, which can be reused for the REST endpoints. The `webuntis` npm `WebUntisSecretAuth` does exactly this and then reads `/WebUntis/api/app/config` for the person ([base.ts `_otpLogin`](https://github.com/SchoolUtils/WebUntis/blob/master/src/base.ts)).
  - It works when the school uses external SSO (Microsoft, Google, Bildungsportal), and the secret does not expire until it is regenerated ([webuntis-mcp README](https://github.com/toughIQ/webuntis-mcp)).
- **2FA.** The WebUntis release notes reportedly state "The old JSON-RPC API can no longer be called with a user for whom 2FA is activated" ([WebUntis Release Notes](https://help.untis.at/hc/en-150/articles/360008456699-WebUntis-Release-Notes) *(search extract, unverified)*). The QR-secret path is the way around this.
- **Finding the children.**
  - Mobile API: `getUserData2017` returns `userData.children[]` (id, firstName, lastName) and `elemType` `LEGAL_GUARDIAN` (= 12) ([auth.py](https://github.com/toughIQ/webuntis-mcp/blob/main/src/webuntis_mcp/auth.py)).
  - REST: `GET /WebUntis/api/rest/view/v1/app/data` returns `user.students[]` (`id`, `displayName`) plus the tenant id and time grid ([find_student_ids.py](https://github.com/Naumsede/webuntis-home-assistant/blob/main/scripts/find_student_ids.py)).
  - Students are element type 5 / `STUDENT`.

### 3. Data per Item type, per API (parent account, child id)

| Item | Mobile 2017 JSON-RPC | Web REST | Public JSON-RPC |
|---|---|---|---|
| **Timetable** (Lessons) | `getTimetable2017 {id: childId, type: "STUDENT", startDate, endDate}` returns periods plus `masterData` (subjects, rooms, teachers) ([client.py](https://github.com/toughIQ/webuntis-mcp/blob/main/src/webuntis_mcp/client.py)) | `GET /api/rest/view/v1/timetable/entries?start&end&resourceType=STUDENT&resources=<childId>&timetableType=MY_TIMETABLE` ([Naumsede README](https://github.com/Naumsede/webuntis-home-assistant)); the parent maps to `STUDENT` ([rest_timetable.py](https://github.com/JonasJoKuJonas/homeassistant-WebUntis/blob/main/custom_components/webuntis/utils/rest_timetable.py), [PR #377](https://github.com/JonasJoKuJonas/homeassistant-WebUntis/pull/377)) | `getTimetable {id: childId, type: 5}` |
| **Timetable Change** | Cancellations, substitutions, room/teacher swaps are derivable from the period codes (`get_changes` tool in webuntis-mcp) | Best: `status` REGULAR/CHANGED/CANCELLED, original vs. new teacher/room (`Fr → Ar`, `[MS2]→043`), substitution text, `is_exam`, lesson info ([Naumsede README](https://github.com/Naumsede/webuntis-home-assistant), [issue #379](https://github.com/JonasJoKuJonas/homeassistant-WebUntis/issues/379)) | `code: cancelled/irregular` only. For a parent login `info`, `lstext` and `substText` came back empty and exams looked like normal lessons ([issue #379](https://github.com/JonasJoKuJonas/homeassistant-WebUntis/issues/379)) |
| **Task: homework** | `getHomeWork2017 {id: childId, type: "STUDENT", …}` | `/api/homeworks/lessons?startDate&endDate` ([base.ts](https://github.com/SchoolUtils/WebUntis/blob/master/src/base.ts)), or `/api/rest/view/v2/calendar-entry/detail?elementId=<childId>&elementType=5&homeworkOption=DUE`. A parent login reportedly gets homework and `teachingContent` this way ([issue #316](https://github.com/JonasJoKuJonas/homeassistant-WebUntis/issues/316)) | Not available |
| **Task/Event: exams** | `getExams2017` | `/api/exams?studentId&klasseId&startDate&endDate` ([base.ts](https://github.com/SchoolUtils/WebUntis/blob/master/src/base.ts)); exam lessons are also flagged in `timetable/entries` | Not available |
| **Notice: messages of the day** (school-wide notices) | `getMessagesOfDay2017 {date}` ([client.py](https://github.com/toughIQ/webuntis-mcp/blob/main/src/webuntis_mcp/client.py)) | `/api/public/news/newsWidgetData?date=` ([base.ts](https://github.com/SchoolUtils/WebUntis/blob/master/src/base.ts)), or by scraping `main.do` ([Naumsede README](https://github.com/Naumsede/webuntis-home-assistant)) | Not available |
| **Notice/Task: personal messages** (WebUntis Messages inbox, e.g. letters to parents) | Not exposed | `GET /WebUntis/api/rest/view/v1/messages` with Bearer JWT ([base.ts `getInbox`](https://github.com/SchoolUtils/WebUntis/blob/master/src/base.ts)); per-message detail and attachments *unverified* | Not available |
| Absences | `getStudentAbsences2017` | `/api/classreg/absences/students` | Not available |

Homework only appears if teachers enter it, which is not mandatory ([BRG Judenburg parent overview](https://www.brg-judenburg.ac.at/wp-content/uploads/2025/09/WebUntis-Uebersicht-fuer-Erziehungsberechtigte.pdf) *(search extract)*).

### 4. What a parent account may *not* see

Visibility is set per school through role rights, not by the API, so "student-only" varies by school. The reported limits are:

- **Master data and other people's timetables.** `getTeachers()` returns "no right" for parents ([issue #316](https://github.com/JonasJoKuJonas/homeassistant-WebUntis/issues/316)). Class, teacher and room timetables may also be denied with "no right for timetable" ([issue #92](https://github.com/JonasJoKuJonas/homeassistant-WebUntis/issues/92)).
- **Lesson content (Lehrstoff / `teachingContent`).** It is available "only for some accounts", depending on school rights ([issue #316](https://github.com/JonasJoKuJonas/homeassistant-WebUntis/issues/316)).
- **Adult students.** In Austria, parents cannot see the timetables of students who are of age ([school guidance](https://www.brg-judenburg.ac.at/wp-content/uploads/2025/09/WebUntis-Uebersicht-fuer-Erziehungsberechtigte.pdf) *(search extract)*).
- **Messages addressed to the child.** Messages sent only to the student's own account are in the *student's* inbox, not the parent's. The parent inbox holds only messages addressed to parents *(unverified, follows from per-user inboxes)*. **Untis Messenger** is a separate chat product for students and teachers with no known API.
- **Inconsistent class names.** REST `timetable/entries` returned an empty `klassen` list for a parent, while JSON-RPC returned `08D` ([issue #379](https://github.com/JonasJoKuJonas/homeassistant-WebUntis/issues/379)).

If a needed piece (for example messages to the child) is missing, the fallback is each child's own student account, which means two more credentials.

### 5. Rate limits and ToS

- **No published rate limits.** None were found for any endpoint.
  - The legacy JSON-RPC spec asks clients to log out as soon as possible to free server resources (quoted in [base.ts](https://github.com/SchoolUtils/WebUntis/blob/master/src/base.ts)).
  - The 2017 API needs a fresh TOTP per call, so bursts are naturally limited.
  - Community integrations poll every few minutes to hourly. Polling once every 15-30 minutes during school days and logging out each time is a conservative choice.
- **ToS.** The Untis terms for automated access by end users were not retrievable. All community libraries state they are unofficial, not affiliated with Untis, and used at the user's own risk.
  - The mobile and REST endpoints are undocumented and "may break without notice" ([Naumsede README](https://github.com/Naumsede/webuntis-home-assistant)).
  - Using your own parent credentials to read your own children's data is the same access the app has, but the account belongs to the school, so the school (the data controller) could object.
  - Risk is low for one family at low volume, but it is not zero. *Unverified: no explicit ToS clause found either way.*

### 6. Maintained client libraries (as of 2026-10-25)

| Library | Lang | API surface | Parent support | Status |
|---|---|---|---|---|
| [SchoolUtils/WebUntis](https://github.com/SchoolUtils/WebUntis) (`webuntis` on npm) | TS/JS | JSON-RPC + REST (homework, exams, inbox, news, absences); password, secret/OTP, QR and anonymous login | Generic `getTimetableFor*(id, type=5)`; no child enumeration | v2.2.1, last commit 2024-04-06. Usable but quiet |
| [python-webuntis](https://github.com/python-webuntis/python-webuntis) | Python | Public JSON-RPC only | Via `timetable(student=…)` | Last commit 2026-07-08; used by the HA integration (`webuntis==0.1.24`) |
| [toughIQ/webuntis-mcp](https://github.com/toughIQ/webuntis-mcp) | Python | Mobile 2017 API, TOTP | **Built for parents**, multiple children (`WEBUNTIS_STUDENT` picks one by first name) | Last commit 2026-09-13. Best reference implementation for us |
| [JonasJoKuJonas/homeassistant-WebUntis](https://github.com/JonasJoKuJonas/homeassistant-WebUntis) | Python | python-webuntis + own REST timetable, homework and exams | Parent fixes in 2026 (PR #377, issue #379) | Very active (last commit 2026-10-16) |
| [Naumsede/webuntis-home-assistant](https://github.com/Naumsede/webuntis-home-assistant) | Python scripts | Web REST + `main.do` scraping | Tested only with a guardian account | Last commit 2026-10-07 |
| Others: [4biddencode/UntAPI](https://github.com/4biddencode/UntAPI) (Node), [Meow/webuntis-api](https://github.com/Meow/webuntis-api) (Ruby, REST), [hexdocs `webuntis`](https://hexdocs.pm/webuntis/json-rpc.html) (Elixir) | | | | Not reviewed in depth |

A community protocol write-up of both APIs is [SafeMemoryZone/webuntis-api-docs](https://github.com/SafeMemoryZone/webuntis-api-docs/blob/master/WEBUNTIS_API.md). It is useful as a map, but it is not authoritative.

## Implications for Family Butler

- **Use one WebUntis Source per Family, not one per Family Member.** Authenticate once with the parent's QR secret (TOTP), enumerate the children (`getUserData2017.children` or REST `app/data.user.students`), and let the Admin map each child id to a Family Member.
- **Prefer the QR-secret/TOTP login over the password.** It survives school SSO and 2FA, stores no password, and the Admin can revoke it by regenerating the key.
- **Use a hybrid fetch.** Get Lessons and Timetable Changes from REST `timetable/entries` (richest change info). Get homework and exams from the 2017 API or REST into Tasks (with Deadline) and Events. Get messages of the day and the parent inbox into Notices. Keep the 2017 API as a fallback for each.
- **Diff Timetable Changes ourselves.** The API gives the current state per lesson, not a change feed, so store the last snapshot and detect new or withdrawn changes.
- **Treat the integration as fragile.** It runs on undocumented endpoints, so isolate it behind a small adapter with contract tests on recorded responses, poll gently, and log out after each poll.
- **Plan for gaps.** Messages addressed to the child, and school-specific rights, may need each child's own student account as an optional second credential. Parents can also have WebUntis messages forwarded by e-mail (profile setting "Benachrichtigungen über neue Mitteilungen per E-Mail erhalten", per [school guides](https://www.nuernberg.de/internet/abendrealschule/webuntis.html) *(search extract)*), which the email Source can pick up as a fallback.
- **Verify first against the real account:** that the REST inbox works for the parent, which rights this school grants guardians (lesson content, homework), and whether 2FA is on.
