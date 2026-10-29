---
status: proposed
---

# The schema holds its own invariants

What the code assumed about the data, Postgres now enforces, so that a bug or a crash cannot leave rows behind that the code would read wrongly.

- **Foreign keys with cascades.** Everything a Source brought in hangs off it by foreign key: its Origins, their raw messages and attachments, their Revisions, and its Item keys. Removing a Source removes them by cascade. An Item goes with the last Source that names it; while another Source still names it, it is recomputed from the Revisions left.
- **Checks rather than enum types.** Kinds, acts and other closed lists of values are `CHECK (… IN (…))` constraints built from the lists in `packages/domain`, as is what columns must hold together, such as a failure's time, kind and message. A check changes in one statement; an enum type cannot lose a value.
- **No copies.** A raw message is keyed by its Origin, and takes its Source from it.
- **Run state apart from configuration.** How a Source's runs went is in `source_health`, one row per Source, which the worker writes on every run; `sources` holds what an Admin configures.
- **Identity columns.** Orders such as a Source's position are identity columns rather than `serial`.

## Consequences

- Secrets are not part of this: the SecretStore is a port of its own (ADR-0006), so a Source or the LLM endpoint refers to a secret without a foreign key, and a secret is stored before what refers to it and removed after. Instead, the worker removes the secrets nothing refers to when it starts, once they are an hour old.
- Removing a Source reads the files of its messages before the cascade, as the BlobStore is outside Postgres.

## Considered Options

- **UUIDs of version 7 and an Item's window as a `tstzrange` with a GiST index**: sort and search better in theory, but at the size of one Family's data they gain nothing measurable and add an id generator and a column type of our own.

- **Removing secrets in the transaction that stops referring to them**: would need the Postgres repositories to write the SecretStore's table behind its port, and would leave secrets behind with any other SecretStore.
