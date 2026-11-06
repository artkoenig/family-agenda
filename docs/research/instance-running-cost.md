# What does one hosted Instance cost to run?

Question (issue #216, under map #222 "Paid hosted Family Agenda"): what do RAM, CPU and disk of one Instance without Messengers come to, what can Instances share without breaking the one-Family-per-Instance boundary (ADR-0013), and what is the infrastructure cost per Family at 10 / 100 / 1000 Families, backups included?

Research date: 2026-11-06.

## Status of the evidence (read first)

- **Resource figures are estimates from the repo, not measurements.** Docker is not available in the research sandbox, so nothing was run. They come from reading `compose.yaml`, `Dockerfile`, `apps/worker/src/main.ts` and ADR-0004/0006/0012/0013, plus general knowledge of Node.js, Postgres and Tesseract memory behaviour. Replace them with a measurement (`docker stats` on `pnpm preview up` with demo data) before a price is fixed.
- **Prices are NOT from a primary source.** `hetzner.com`, `docs.hetzner.com` and the Hetzner API are outside the sandbox's allowed network (DNS and proxy refuse them), so the Hetzner price list and price-adjustment page could not be read. The figures below come from third-party write-ups found by search and are marked *unverified*. Hetzner raised cloud prices at least twice in 2026 (April 1 and June 15), so older numbers are stale. Before this feeds the price, someone should read the official pages: <https://www.hetzner.com/cloud/regular-performance> and <https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/>.
- The conclusion (about 1 to 2 EUR per Family per month of infrastructure) is insensitive to the unverified numbers: even doubling every price leaves it under 4 EUR.

## What one Instance runs

Hosted without Messengers, an Instance is three processes from one image (`compose.yaml`, `Dockerfile`):

| Process | What it does | Notes |
|---|---|---|
| `api` | Node 26 (`node --import tsx src/main.ts`), HTTP on port 3000, server-rendered HTML, health check | Sources are TypeScript run through `tsx` at start, so a transpiler sits in memory |
| `worker` | Node, same image. Ticks every 5 s: polls due Sources, extracts pending messages through the LLM endpoint, reconciles Source Type services; hourly retention purge, daily secret sweep (`apps/worker/src/main.ts`) | Mostly idle, wakes briefly. Starts Synapse and bridges **only while an Admin enables a Messenger** (ADR-0011) |
| `postgres` | `postgres:17`, one database `family_agenda` | The only stateful process besides files |
| `mdns` | Announces `family-agenda.local` on the home LAN | **Not needed hosted**: drop it, and set `PUBLIC_URL` and `TRUST_PROXY=true` behind the host's reverse proxy |

Volumes per Instance: `postgres-data`, `master-key` (a file, tiny), `blobs` (raw messages and PDFs, ADR-0006), `plugins` (empty on the stock image), `tessdata` (bundled `deu`, `eng`, `osd` models linked in at start, plus any downloaded ones, ADR-0012), and, only with a Messenger, `matrix-instance` and `matrix-data`.

Tesseract and poppler are not services. They are child processes started per scanned attachment, so they cost RAM only while a PDF is being read.

Synapse (a Python process) and the WhatsApp bridge are in the image but are not started without a Messenger. A hosted plan with Messengers would add a Synapse server (several hundred MB of RAM is typical even for a tiny one) plus a bridge per Messenger per Instance, which would change every figure below. ADR-0004 also says Messenger Sources should not run in the provider's cloud, so this research leaves them out.

## Per-Instance resources (estimates)

| Resource | Idle | Typical (a few Sources, one extraction running) | Peak |
|---|---|---|---|
| `api` RAM | 120 to 180 MB | 150 to 250 MB | 300 MB |
| `worker` RAM | 120 to 180 MB | 150 to 250 MB | 300 MB |
| `postgres` RAM (default 128 MB `shared_buffers`, few connections) | 60 to 100 MB | 100 to 150 MB | 200 MB |
| Tesseract + poppler on a multi-page scan | 0 | 0 | +150 to 500 MB, transient |
| **Total RAM** | **about 0.3 to 0.45 GB** | **about 0.45 to 0.65 GB** | **about 1 GB** during OCR |
| CPU | near 0 | under 5 % of one core averaged, bursts while polling and extracting | one core for tens of seconds during OCR |
| Disk, database | 40 to 50 MB (empty cluster plus schema) | 50 to 300 MB per year of use | |
| Disk, blobs | 0 | about 0.3 to 2 GB per year, dominated by school-letter PDFs and scans (the number most worth measuring) | |
| Disk, `tessdata` | about 15 to 25 MB (bundled "fast" models) | +2 to 15 MB per added language | |
| Disk, image | about 1.2 to 1.6 GB, once per host, not per Instance (layers are shared) | | |

Notes:
- The OCR peak is why hosts should not be packed to 100 % of RAM. It is rare and short, and with a dozen Instances per host simultaneous peaks are unlikely but possible.
- Hosted Instances poll over the internet (IMAP, ICS, WebUntis), so traffic is small, a few GB per month at most.
- A shared Postgres server would need `max_connections` sized for api plus worker per Instance (a handful each).

## What can be shared without crossing the Family boundary

ADR-0013 makes the database the Family boundary: one Instance, one database, no `family_id` anywhere, and "serving several Families from one Instance would need a Family id added to every aggregate root and every query again", which it rejects. ADR-0004 likewise settles on one Instance per Family. So sharing is allowed only at the infrastructure layer below the app. Each Instance keeps its own `api` and `worker` processes, its own database, `master-key` and blobs.

| Sharing level | What is shared | What stays per Instance | Boundary risk |
|---|---|---|---|
| **0. Nothing** | nothing: one VM per Family | everything | none; strongest isolation, highest cost |
| **A. Shared host and image** | the VM, the Docker engine, image layers (one copy of about 1.4 GB), one reverse proxy with wildcard TLS routing by hostname | Compose stack with its own Postgres container and volumes | low: separate containers and networks per Instance; same kernel |
| **B. A plus one Postgres server** | additionally one Postgres process, with one database and one role per Instance (`CREATE DATABASE ... OWNER`, `REVOKE CONNECT ... FROM PUBLIC`) | `api`, `worker`, blobs, master key, `tessdata` | moderate: the database is still the boundary (a role reaches only its database), but a Postgres bug, a mis-granted role or a noisy neighbour is now cross-Family. Per-Instance restore stays a `pg_dump` of one database |
| **C. Sharing inside the app** (one `api` or `worker` for many Families) | Node processes | | **Rejected**: this is the multi-tenant design ADR-0004 and ADR-0013 rule out |

Smaller items:
- **Tesseract models**: the bundled models are about 20 MB per Instance, so sharing saves almost nothing, and the `tessdata` volume is written per Instance (Admin downloads and deletes, ADR-0012), so a shared one would let one Family's Admin change another's models. Keep per Instance.
- **Reverse proxy and TLS**: share. One Caddy or Traefik per host, wildcard certificate, `TRUST_PROXY=true`. It only routes bytes.
- **`mdns`**: drop.
- **Synapse**: not shareable sensibly, since the worker creates Synapse's database in the Instance's own Postgres and bridges hold per-Family Messenger sessions. Out of scope without Messengers.

Provisioning implication: levels 0, A and B all fit the existing Compose file with small changes (no `mdns`, an external proxy network, optionally an external `DATABASE_URL`). The unit of scheduling is the Compose project, so hosting one Family per project needs no code change to the app.

## Candidate EU hosts and prices

Only Hetzner was priced, as the ticket names it. OVHcloud, Scaleway, IONOS and Netcup were not priced because their sites are not reachable from the sandbox either.

Hetzner Cloud, EUR per month excluding VAT, **unverified**, from third-party write-ups of the April and June 2026 price changes ([Tom's Hardware on the April increase](https://www.tomshardware.com/tech-industry/hetzner-to-raise-prices-by-up-to-37-percent-from-april-1), [bitdoze](https://www.bitdoze.com/es/hetzner-cloud-precios-2026/), [webhosting.today on the June round](https://webhosting.today/2026/06/18/hetzners-price-increases-reached-209-the-30-headline-applied-to-a-different-tier/)):

| Plan | vCPU / RAM / SSD | Price after 15 June 2026 (unverified) |
|---|---|---|
| CX23 | 2 / 4 GB / 40 GB | 5.49 (was 3.99, and 2.99 before April) |
| CX33 | 4 / 8 GB / 80 GB | 8.49 (was 6.49) |
| IPv4 address | | +0.50 per address |
| Object Storage | 1 TB base | 6.49 (was 4.99); overage per TB not found |

Caveats: one report says the CX/CAX lines showed "not available" in September and October 2026, so capacity needs checking. The CPX line rose far more (+144 % to +176 %), so plan on the cheaper CX or ARM `CAX` lines. Storage Box prices were not found in usable form. A CX43 (16 GB) is estimated around 21 EUR after June (my estimate from the reported percentages), so larger plans cost more per GB and the 8 GB plan is the sweet spot.

## Cost per Family per month

Assumptions, all changeable:
- Host: CX33 at 8.49 plus one IPv4 at 0.50 = **8.99 EUR**.
- Usable RAM for Instances: about 6.5 GB (rest for OS, Docker, proxy). Instances per host: **8 at level A** (about 0.65 GB each, own Postgres), **12 at level B** (about 0.45 GB each, shared Postgres).
- Disk: 80 GB holds 12 Instances at about 2 GB of blobs each plus image and OS. No extra volumes are priced.
- Level 0 baseline: one CX23 (5.49) plus IPv4 (0.50) = **5.99 EUR** per Family.
- Backups (ADR-0004 and ADR-0006: encrypted on the Instance, ciphertext off-site): about 2 GB stored per Family (blobs plus a retained set of compressed dumps), at Object Storage 6.49 EUR per TB, which is 0.013 EUR per Family when full. At small scale the 6.49 base fee dominates.
- Not included: VAT, the Remote Access relay, the hosted LLM endpoint (likely the largest variable cost, covered by other tickets), support time, monitoring, spare capacity, staging.

| Families | Level 0 (VM per Family) | A (shared host, own Postgres) | B (shared host and Postgres) | Backup storage per Family |
|---|---|---|---|---|
| 10 | 5.99 each, 59.90 total | 2 hosts, 17.98 total, **1.80** each | 1 host, 8.99 total, **0.90** each | 6.49 base / 10 = 0.65 |
| 100 | 5.99 each, 599 total | 13 hosts, 116.87 total, **1.17** each | 9 hosts, 80.91 total, **0.81** each | 6.49 / 100 = 0.065 |
| 1000 | 5.99 each, 5 990 total | 125 hosts, 1 123.75 total, **1.12** each | 84 hosts, 755.16 total, **0.76** each | about 0.013 (2 TB, about 13 total) |

Per Family, infrastructure plus backup:

| Families | Level 0 | A | B |
|---|---|---|---|
| 10 | about 6.64 | about 2.45 | about 1.55 |
| 100 | about 6.06 | about 1.24 | about 0.88 |
| 1000 | about 6.00 | about 1.13 | about 0.77 |

With a 30 % allowance for spare capacity, staging and monitoring, level B lands at roughly 1.0 to 2.0 EUR per Family per month and level A at 1.5 to 3.2 EUR.

## Findings

1. **Infrastructure is cheap, about 1 to 2 EUR per Family per month, once Instances share hosts.** A VM per Family costs about 6 EUR, five to eight times more, so a plan priced well above that is not driven by infrastructure.
2. **Level A (shared host, one Compose project per Family, shared proxy) captures most of the saving at low isolation cost.** Level B saves another 25 to 30 % but puts all Families in one Postgres process. It stays inside ADR-0013 (the database is the boundary) but weakens the operational story, so it is a choice for the architecture ticket, not forced by cost.
3. **Per-Family cost barely changes beyond about 100 Families.** Fixed costs (the backup base fee, one host) matter only below that.
4. **RAM, not CPU or disk, sets the density.** Two Node processes plus Postgres are about 0.45 to 0.65 GB per Instance, and OCR bursts need headroom. Running compiled JS instead of `tsx`, or capping Node's old-space size, is the most direct lever to raise density.
5. **Backups cost cents per Family**, so off-site backup can be bundled rather than priced separately. Restore egress was not priced.
6. **Messengers change the picture**: Synapse and bridges per Instance would plausibly double RAM per Instance. A hosted plan should state whether Messengers are offered.

## Open items

- Measure real RSS, CPU, DB and blob growth: `pnpm preview up <pr>` with demo data, then `docker stats`, one scanned 10-page PDF through OCR, and `du` on the volumes after a month.
- Read Hetzner's official price list and price-adjustment page, and Object Storage and Storage Box pricing; confirm CX/CAX availability.
- Price at least one other EU host (OVHcloud, Scaleway, IONOS, Netcup), since Hetzner has raised prices repeatedly in 2026.
- Decide the isolation level (A or B) in the provisioning-architecture ticket.
