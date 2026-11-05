---
status: proposed, partly superseded by ADR-0016
---

# An Instance is one Family, without Family ids in the data model

Supersedes ADR-0007.

Every Instance has its own database, and a hosted offering would give each Family its own Instance rather than share one (ADR-0004). The Family is therefore implied by the database: there is no `families` table and no `family_id` column. What belonged to the Family itself, its Family Language, its OCR languages and when the Recovery Kit was confirmed, is the one row of `settings`, which the schema creates. Tables that hold at most one thing per Family, `settings`, `llm_endpoints` and `background_activities`, have a boolean key that a check constraint holds at `true`, so a second row cannot exist.

## Consequences

- No query filters by Family, and no use case looks up the Family before it starts.
- A Family remains a domain term: it owns all Sources and Items of its Instance.
- Serving several Families from one Instance would need a Family id added to every aggregate root and every query again. We accept that, since neither the self-hosted Instance nor a hosted one per Family needs it.

## Considered Options

- **Keep a `family_id` on every aggregate root (ADR-0007)**: kept the Family an explicit boundary for a later change of mind, but every query carried an id that only ever had one value. It was also copied into Origins, Revisions and raw messages, where nothing checked that it matched their Item's.

_Amended by ADR-0016: `settings` is now `family`, still without a Family id, and tables are named in the singular, so the single-row tables are `family`, `llm_endpoint` and `background_activity`._

_Amended by ADR-0017: `identity_provider` is a further single-row table._
