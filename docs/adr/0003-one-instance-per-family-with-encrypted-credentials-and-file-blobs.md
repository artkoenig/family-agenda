---
status: accepted
---

# One Instance serves one Family; credentials are encrypted at rest and blobs live in files

Every Instance has its own database and serves exactly one Family, so the Family is implied by the database: there is no `families` table and no `family_id` column, and no query filters by Family. A provider hosting Family Agenda as a service runs one Instance per Family, which keeps tenants isolated without row-level security. Stateless plugins can still be shared between Instances, because they hold nothing (ADR-0001).

Postgres dumps get copied, attached to bug reports and uploaded as backups, so Source credentials never appear in them in clear text. A `SecretStore` port encrypts each credential with the master key, which is never in Postgres. Raw attachments such as PDFs and images live behind a `BlobStore` port, by default the filesystem; Postgres holds only their metadata. Files and secrets that nothing refers to any more are swept (ADR-0005).

## Consequences

- A backup is a Postgres dump plus the blob volume, without the master key. The Admin keeps a Recovery Kit; without it a restored backup cannot open Source credentials.
- Secrets leave the core only decrypted inside a call to the plugin of their own Source Type (ADR-0001).
- Several Families on one Instance, or a shared multi-tenant database, would need every table and query touched.

## Amendment: a public Family id (plugin contract 3.0)

The `family` row has a `public_id`, a random UUID made with the row. It names the Family only outside its database: the ticket of a plugin call carries it (ADR-0001), and the api resolves a ticket's Family by it before reading that Family's Sources. Inside the database nothing changes: there is still no `families` table and no `family_id` column, and no query filters by Family. Today an Instance answers only for its own `public_id`; when one Instance serves several Families, each in its own database, the same id is how a request from a shared stateless plugin's Egress Proxy says which database to ask.
