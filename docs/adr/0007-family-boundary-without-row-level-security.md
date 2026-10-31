---
status: superseded by ADR-0013
---

# The Family stays a boundary in the data model, without row-level security

An Instance serves exactly one Family, and Agenda Cloud never hosts Items (ADR-0004). Tenant isolation therefore has no job to do inside an Instance. We still keep a `families` table and a `family_id` foreign key on every aggregate root (Family Members, Sources, Items, Agendas), because that costs one column and keeps the Family an explicit boundary in the domain and in queries. We add no Postgres row-level security, no per-request tenant context and no tenant-aware job routing.

## Considered Options

- **Row-level security from the first migration**: the right call for a multi-tenant SaaS. Here it would wrap every query and every pg-boss job in a transaction with `SET LOCAL`, and nothing would use it.
- **Drop `family_id` altogether**: the cheapest option, but a later change of mind (several Families per Instance, or a hosted version after all) would then need every table and every query touched.
