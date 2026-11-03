# Family Agenda

![Information chaos everywhere](docs/assets/family-agenda.webp)

Self-hosted overview of who has to be where, when, with what. It gathers school timetables (WebUntis), calendars (ICS), school mail (IMAP, PDFs incl. OCR) and Messengers (WhatsApp via Matrix bridge) into one agenda per family member. Local-first: data stays on your server, no cloud needed.

## Install & start

Requires Docker with Compose.

```sh
git clone https://github.com/artkoenig/family-agenda.git
cd family-agenda
docker compose up -d --build
```

Open `http://localhost:8080`, create the first Admin, keep the Recovery Kit safe. Then add Family Members, Agendas and Sources in the Admin area.


## Hardware

- 64-bit host running Docker, always on: Raspberry Pi, NAS, mini PC or server. Linux needed for `family-agenda.local` (mDNS).
- RAM: ~2 GB for api, worker, Postgres; +0.5 GB with Messengers enabled (Synapse + bridge).
- Disk: a few GB for image and data; more for mail attachments.
- LLM (mail extraction): any OpenAI-compatible endpoint. Cloud API (no extra hardware) or local, e.g. Ollama with a 9B model on 8-12 GB VRAM.

## License

AGPLv3, see [LICENSE](LICENSE).
