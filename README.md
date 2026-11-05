<div align="center">

# 🏠 Family Agenda

**Who has to be where, when, with what, in one calm overview.**

Self-hosted · Local-first · No cloud needed

[![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](LICENSE)
![Docker](https://img.shields.io/badge/runs%20on-Docker%20Compose-2496ED?logo=docker&logoColor=white)
![Node](https://img.shields.io/badge/node-%E2%89%A522.12-339933?logo=nodedotjs&logoColor=white)

<img src="docs/assets/family-agenda.webp" alt="Information chaos everywhere" width="720">

</div>

---

## ✨ What it does

School timetables, club calendars, school mails with PDF attachments, parent chats: the family's information is scattered everywhere. Family Agenda collects it all and shows **one agenda per family member**, on your own server.

| | Source | How it is read |
|---|---|---|
| 🎓 | **School timetable** | WebUntis: lessons, substitutions, room changes |
| 📅 | **Calendars** | ICS feeds: clubs, school, holidays |
| ✉️ | **School mail** | IMAP, including PDF attachments (OCR) |
| 💬 | **Parent chats** | WhatsApp and other Messengers via Matrix bridge |

## 📸 See it

![The Admin area and an Agenda on a phone](docs/assets/screenshots.png)

## 🔍 How it works

![How Family Agenda works: sources are collected, an LLM extracts items, agendas are served to clients](docs/assets/how-it-works.png)

1. **Collect**: a worker polls every Source and keeps each Source Record it delivers.
2. **Extract**: mails, PDFs and chat messages are read once by an LLM (any OpenAI-compatible endpoint, cloud or local) to find what matters. Calendars and timetables are structured already and skip this step.
3. **Items**: findings become **Events**, **Lessons** and **Tasks**, each attributed to the Family Members it concerns.
4. **Agendas**: one per Family Member, or one for the whole Family, as a timeline of days or a Task List.

Agendas open without signing in on the home network (kitchen tablet, phones). Away from home, a secret, revocable **Agenda Link** opens a single Agenda. Sources, members and agendas are managed in the Admin area.

## 🚀 Install & start

Requires Docker with Compose.

```sh
git clone https://github.com/artkoenig/family-agenda.git
cd family-agenda
docker compose up -d --build
```

Open `http://localhost:8080`, create the first Admin, keep the **Recovery Kit** safe. Then add Family Members, Agendas and Sources in the Admin area.

> [!NOTE]
> Upgrading from a version before the data model was rebuilt (ADR-0016)? Instances start over: see [RELEASE_NOTES.md](RELEASE_NOTES.md).

## ⚙️ Configuration

Container variables, the address the Family opens, HTTPS behind a proxy and single sign-on for Admins: see [docs/configuration.md](docs/configuration.md).

## 🖥️ Hardware

| | Needs |
|---|---|
| **Host** | 64-bit, always on, running Docker: Raspberry Pi, NAS, mini PC or server. Linux needed for `family-agenda.local` (mDNS). |
| **RAM** | ~2 GB for api, worker, Postgres; +0.5 GB with Messengers enabled (Synapse + bridge). |
| **Disk** | A few GB for image and data; more for mail attachments. |
| **LLM** | Any OpenAI-compatible endpoint. Cloud API (no extra hardware) or local, e.g. Ollama with a 9B model on 8-12 GB VRAM. |

## 📄 License

AGPLv3, see [LICENSE](LICENSE).
