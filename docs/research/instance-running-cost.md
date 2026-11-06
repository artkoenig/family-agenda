# What does one hosted Instance cost to run?

Question (issue #216, under map #222 "Paid hosted Family Agenda"): what do RAM, CPU and disk of one Instance without Messengers come to, what can Instances share without breaking the one-Family-per-Instance boundary (ADR-0013), and what is the infrastructure cost per Family at 10 / 100 / 1000 Families, backups included?

Research date: 2026-11-06 (revised the same day after network access and Docker became available; the first version rested on estimates and third-party price reports).

## Status of the evidence

- **Footprint is measured**, on the repo's own `compose.yaml` layered with `tools/preview/compose.preview.yaml` (the preview stack of `docs/preview.md`, without `mdns`), seeded with the demo Family by `tools/preview/src/seed-main.ts`. Docker 29.9 on a 4-vCPU, 15.7 GiB sandbox. One deviation: the image was built from `Dockerfile` with only the `apt` step changed (HTTPS mirror through the sandbox proxy and its CA), because the sandbox cannot reach `deb.debian.org` over plain HTTP. Everything else in the Dockerfile ran unmodified. Figures are `docker stats` (cgroup memory, which excludes reclaimable page cache) unless stated. The scanned-PDF figure comes from a synthetic 10-page PDF, not real school scans.
- **Not measured**: blob growth per Family (needs real use over time), several Instances on one host, Postgres under a real load. The 0.3 to 2 GB per year blob figure remains an estimate.
- **Hetzner prices are from Hetzner's own pages**, fetched 2026-11-06: <https://www.hetzner.com/cloud/cost-optimized>, <https://www.hetzner.com/cloud/regular-performance>, <https://www.hetzner.com/storage/object-storage>, and the public price API the site itself uses (<https://website-price-api.hetzner.com/api/docs>). The path `docs.hetzner.com/.../price-adjustment/` returned 404, so the price-adjustment notice was not read; the live product pages are the current prices anyway.
- **Other providers' prices are from their own public pages**, fetched the same day, with country-specific store fronts (the German OVHcloud, IONOS and Netcup pages; the English Scaleway page). Where a page shows prices including VAT, the net figure is my calculation at 19 % (German VAT) and is marked as such.

## What one Instance runs

Hosted without Messengers, an Instance is three processes from one image (`compose.yaml`, `Dockerfile`):

| Process | What it does | Notes |
|---|---|---|
| `api` | Node 26 (`node --import tsx src/main.ts`), HTTP on port 3000, server-rendered HTML | Sources are TypeScript run through `tsx` |
| `worker` | Node, same image. Ticks every 5 s: polls due Sources, extracts pending messages through the LLM endpoint, reconciles Source Type services, hourly retention purge, daily secret sweep (`apps/worker/src/main.ts`) | Starts Synapse and bridges **only while an Admin enables a Messenger** (ADR-0011) |
| `postgres` | `postgres:17`, one database `family_agenda` | The only stateful process besides files |
| `mdns` | Announces `family-agenda.local` on the home LAN | **Not needed hosted**: drop it, set `PUBLIC_URL` and `TRUST_PROXY=true` behind the host's reverse proxy |

Volumes per Instance: `postgres-data`, `master-key`, `blobs` (raw messages and PDFs, ADR-0006), `plugins`, `tessdata` (bundled models linked in at start, ADR-0012), and with a Messenger `matrix-instance` and `matrix-data`. Tesseract and poppler are child processes started per scanned attachment, not services. Synapse and the WhatsApp bridge are in the image but not started without a Messenger (ADR-0004 also doubts they should run in the provider's cloud), so Messengers are out of scope here.

## Per-Instance footprint (measured)

| Resource | Measured |
|---|---|
| RAM, container start | api 195 MiB, worker 170 MiB, Postgres 42 MiB: about **410 MiB** for the first minute (api's `VmHWM` was 279 MB while `tsx` loaded the sources) |
| RAM, steady idle, seeded, minutes later | api 85 to 102 MiB, worker 69 to 71 MiB, Postgres 46 to 51 MiB: about **210 to 225 MiB** in total |
| RAM, after 600 HTTP requests (health, `/`, `/admin`) | unchanged: api 85 MiB, worker 71 MiB, Postgres 46 MiB |
| RAM, OCR burst (10 pages at 300 dpi, `pdftoppm -r 300 -gray` then `tesseract -l deu+eng`, as in `command-line-text-extractor.ts`) | worker peaked at **318 MiB** (about +250 MiB for poppler and Tesseract); api 196 MiB and Postgres 56 MiB barely moved |
| CPU, idle | api 0.1 to 0.3 %, worker 0.6 to 1.6 % (the 5 s ticks), Postgres under 1 % of one core: about **1 % of a core** per Instance |
| CPU, OCR | up to **317 %** of the 4 vCPUs (Tesseract is multi-threaded); 76 s for 10 dense A4 pages, about 7.6 s per page |
| Postgres after the demo seed (four Family Members, four Agendas, one demo Source) | database **9.8 MB**; the whole data directory is 48 MB (the empty cluster) |
| Postgres connections | 9 in `pg_stat_activity`, `max_connections` 100, `shared_buffers` 128 MB (defaults) |
| `tessdata` | bundled `deu`, `eng`, `osd` models: **16 MB** (in the image, linked into the volume) |
| Image | **1.36 GB** on disk, 317 MB compressed; of which the Synapse venv is 253 MB, the app and `node_modules` 119 MB, the WhatsApp bridge 31 MB, `tessdata` 16 MB. One copy per host, layers shared by all Instances on it |
| Blobs | 0 for the seed; **not measured**. Estimate 0.3 to 2 GB per year, dominated by school-letter PDFs and scans |

Compared with the first version's estimates, steady RAM is about half (0.22 GB against 0.45 to 0.65 GB). The transient at start and the OCR burst are what the host must be sized for, not the idle figure.

## What can be shared without crossing the Family boundary

ADR-0013 makes the database the Family boundary: one Instance, one database, no `family_id`, and "serving several Families from one Instance would need a Family id added to every aggregate root and every query again", which it rejects. ADR-0004 likewise settles on one Instance per Family. So sharing is allowed only below the app. Each Instance keeps its own `api` and `worker` processes, its own database, `master-key` and blobs.

| Sharing level | What is shared | What stays per Instance | Boundary risk |
|---|---|---|---|
| **0. Nothing** | nothing: one VM per Family | everything | none; highest cost |
| **A. Shared host and image** | the VM, the Docker engine, image layers (one 1.36 GB copy), one reverse proxy with wildcard TLS routing by hostname | a Compose project with its own Postgres container and volumes | low: separate containers and networks; same kernel |
| **B. A plus one Postgres server** | additionally one Postgres process with a database and a role per Instance (`CREATE DATABASE ... OWNER`, `REVOKE CONNECT ... FROM PUBLIC`) | `api`, `worker`, blobs, master key, `tessdata` | moderate: a role reaches only its database, so ADR-0013's boundary holds, but a Postgres bug, a mis-granted role or a noisy neighbour is cross-Family. Per-Instance restore stays a `pg_dump` of one database |
| **C. Sharing inside the app** | Node processes | | **Rejected**: the multi-tenant design ADR-0004 and ADR-0013 rule out |

Measured saving from B: one Postgres container is 42 to 56 MiB, so sharing it saves roughly 35 to 45 MiB per Instance, about a sixth of the steady footprint. That is small, so B buys density and operational simplicity less than it first seems; its main cost is the weaker isolation.

Smaller items: sharing `tessdata` saves 16 MB per Instance and would let one Family's Admin change another's models (the volume is written per Instance, ADR-0012), so keep it per Instance. Share the reverse proxy and TLS. Drop `mdns`. Synapse cannot be shared sensibly.

Provisioning implication: levels 0, A and B fit the existing Compose file with small changes (no `mdns`, an external proxy network, optionally an external `DATABASE_URL`). One Family per Compose project needs no change to the app.

## Hosts and prices (all EUR per month, from the providers' own pages)

An 8 GB, 4 vCPU host is the unit. Hetzner prices are excluding VAT. The Hetzner product pages carry a "Price incl. IPv4" label, and the listed CX33 8.99 is the third-party-reported 8.49 plus 0.50 for IPv4, so the plan prices below include one IPv4 address.

| Provider and plan | vCPU / RAM / disk | Monthly | Notes |
|---|---|---|---|
| **Hetzner CX33** (Intel/AMD, cost-optimized) | 4 / 8 GB / 80 GB NVMe | **8.99** excl. VAT | **"not available" and "currently unavailable" on the product page at fetch time**; the page says availability is limited for this line |
| Hetzner CAX21 (Ampere ARM) | 4 / 8 GB / 80 GB | 10.99 | also "not available"; the Dockerfile's image would need an ARM build |
| Hetzner CX23 / CAX11 | 2 / 4 GB / 40 GB | 5.99 / 6.49 | also "not available" |
| Hetzner CX43 / CX53 | 8 / 16 GB, 16 / 32 GB | 16.49 / 29.99 | also "not available" |
| **Hetzner CPX32** (regular performance, AMD) | 4 / 8 GB / 160 GB NVMe | **35.99** | the regular-performance page lists CPX plans (CPX22 19.99, CPX42 69.99); 12 "currently unavailable" markers on that page, so availability per plan was not resolved from the HTML. CPX32 is four times the CX33 price |
| **OVHcloud VPS-2** | 4 / 8 GB / 75 GB NVMe | **8.58 incl. VAT**, about **7.21 net** (my calculation at 19 %) | the German page, "Ab" (from); unlimited traffic, 1 Gbit/s, daily backup of the previous 24 hours included, commitment terms not shown |
| IONOS VPS L+ | 4 / 8 GB / 240 GB NVMe | 7 incl. VAT for the first 3 months, then not shown on the page; 10 setup fee | a promotion, not a steady-state price |
| Netcup VPS 1000 G12.5 | 4 / 8 GB / 128 GB | 14.50 net (16.68 incl. VAT) | 12-month contract |
| Scaleway DEV1-L | 4 / 8 GB | about 31.27 before tax | per-hour billing; BASIC2-A4C-8G about 37.74, PLAY2-MICRO about 40.20 |

Hetzner's other stated terms, from the same pages:
- **Traffic:** at least 20 TB included on EU locations (NBG1, HEL1, FSN); each extra TB is charged 1.00 per TB. Far above what Instances polling mail and calendars use.
- **Locations:** the cost-optimized page lists eu-central NBG1 and HEL1; Object Storage is in FSN1, HEL1 and NBG1.
- **Server backups:** daily, seven slots, priced at 20 % of the server (page: "starting at 1.198", which is 20 % of 5.99); snapshots 0.0143 per GB per month. A server backup does not cover attached volumes. These are host-level and not used below, since backups are encrypted per Instance and sent off-site (ADR-0004, ADR-0006).
- **Object Storage:** base fee **6.49 per month** including **1 TB of storage and 1 TB of egress**; storage beyond that 0.0087 per TB-hour (about **6.35 per TB-month**, at 730 hours); ingress, S3 requests and traffic inside the eu-central zone are free; unused quota does not carry over. Up to 100 buckets.
- **Storage Box** (alternative backup target): BX11 3.20 per month, BX21 10.90, BX31 20.80, BX41 40.60.

**Cheapest EU option for an 8 GB host:** OVHcloud VPS-2 at about 7.21 net, if its VAT-inclusive price of 8.58 is the steady price. Hetzner CX33 is 8.99 and is the price to plan on only if capacity returns; at the moment of this check the only Hetzner 8 GB plan whose page does not say "unavailable" for everything is CPX32 at 35.99, and even that was not confirmed. The ticket's assumption that Hetzner is the cheapest EU host holds only on paper while CX/CAX plans cannot be ordered. A provisioning architecture should not depend on one provider's capacity or on a price that has changed three times this year.

## Cost per Family per month

Assumptions:
- Host: **8.99** (Hetzner CX33, incl. IPv4), with sensitivity to 7.21 (OVH VPS-2 net) and 35.99 (Hetzner CPX32).
- Density per 8 GB host, from the measurements and kept conservative: steady footprint is 0.22 GB, but an OCR burst adds 0.25 GB and up to three of four vCPUs for about a minute, and start-up transients reach 0.41 GB. Reserving about 1.5 GB for the OS, Docker and the proxy, and headroom for a few simultaneous bursts: **16 Instances per host at level A** (own Postgres, about 0.25 GB each) and **20 at level B** (shared Postgres, about 0.2 GB each). CPU is the more likely limit than RAM: 20 Instances idle at about 20 % of one core, but simultaneous OCR bursts compete for four vCPUs, which delays extraction (minutes) without failing it.
- Disk: 80 GB holds 16 to 20 Instances at about 2 GB of blobs each, plus 1.4 GB of image and the OS.
- Backups: about 2 GB stored per Family (blobs plus a retained set of compressed dumps; an estimate), on Hetzner Object Storage at 6.49 base for the first TB and about 6.35 per additional TB. Restore egress of 1 TB per month is included.
- Level 0 baseline: one CX23 at 5.99 per Family.
- Not included: VAT, the Remote Access relay, the hosted LLM endpoint (likely the largest variable cost, other tickets), support, monitoring, spare capacity, staging.

Hosts needed and infrastructure cost per Family at the primary price (8.99):

| Families | Level 0 (VM per Family) | A: hosts, per Family | B: hosts, per Family | Backup per Family |
|---|---|---|---|---|
| 10 | 5.99 | 1 host, **0.90** | 1 host, **0.90** | 6.49 / 10 = **0.65** |
| 100 | 5.99 | 7 hosts (62.93), **0.63** | 5 hosts (44.95), **0.45** | 6.49 / 100 = **0.065** (200 GB, within the first TB) |
| 1000 | 5.99 | 63 hosts (566.37), **0.57** | 50 hosts (449.50), **0.45** | (6.49 + 6.35) / 1000 = **0.013** (2 TB) |

Total per Family, infrastructure plus backup:

| Families | Level 0 | A | B |
|---|---|---|---|
| 10 | about 6.64 | about 1.55 | about 1.55 |
| 100 | about 6.06 | about 0.70 | about 0.52 |
| 1000 | about 6.00 | about 0.58 | about 0.46 |

Sensitivity to the host price (infrastructure only, per Family, level A / level B):

| Host | 100 Families | 1000 Families |
|---|---|---|
| OVH VPS-2, 7.21 net | 0.50 / 0.36 | 0.45 / 0.36 |
| Hetzner CX33, 8.99 | 0.63 / 0.45 | 0.57 / 0.45 |
| Hetzner CPX32, 35.99 (if CX stays unavailable) | 2.52 / 1.80 | 2.27 / 1.80 |

With a 30 % allowance for spare capacity, staging and monitoring, the central case is about 0.7 to 1.2 EUR per Family per month at 100 to 1000 Families, and about 2 EUR at 10 Families because the fixed backup fee and one whole host are spread over few Families.

## Findings

1. **Infrastructure is about 0.5 to 1.5 EUR per Family per month with shared hosts, against about 6 EUR for a VM per Family.** The measured footprint is smaller than first estimated: 0.22 GB steady, 1 % of a core idle, a 9.8 MB database for a seeded Family. Infrastructure is not what drives the plan price.
2. **Level A (shared host, one Compose project per Family, shared proxy) is enough.** Level B saves a further quarter of host cost but only about 40 MiB per Instance, at the price of a shared Postgres process. B stays inside ADR-0013 but weakens the isolation story, so it is an architecture-ticket choice, not forced by cost.
3. **The binding limits are OCR bursts and start-up, not idle RAM.** One 10-page scan takes 76 s and up to three of four vCPUs, and the worker's RAM rises from 70 to 318 MiB. Packing is a question of how many Families run OCR at once, so extraction should be queued per host. Running compiled JS instead of `tsx` would lower the 0.41 GB start-up transient.
4. **Hetzner's cheap lines were not orderable at fetch time.** Every CX and CAX plan page says "not available" and describes limited capacity. Planning on 8.99 per host needs that confirmed, otherwise CPX32 at 35.99 makes the same density cost four times more (still only 1.8 to 2.5 EUR per Family at 100 or more Families). OVHcloud VPS-2 is the cheapest 8 GB EU host found and should be evaluated as a second provider.
5. **Backups cost cents per Family**, so off-site backup can be bundled. Hetzner Object Storage includes 1 TB of storage and 1 TB of egress in the 6.49 base fee, enough for restores.
6. **Messengers change the picture**: Synapse and bridges per Instance (the image carries a 253 MB Synapse venv and a 31 MB bridge) would plausibly add several hundred MB of RAM per Instance. A hosted plan should state whether Messengers are offered.

## Still open

- Blob growth per Family over months, and how large real scanned letters are; the 2 GB per Family backup figure rests on an estimate.
- Several Instances on one host under concurrent OCR (the density of 16 to 20 per host is reasoned from single-Instance measurements, not tested).
- Whether Hetzner's CX/CAX capacity returns, and the commitment terms and steady price of OVHcloud VPS-2 and IONOS VPS L+ beyond the first months.
- Netcup, IONOS and OVH figures come from German store-front pages; their EU hosting locations were not checked against each provider's data-centre list.
