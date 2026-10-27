---
status: proposed
---

# Source credentials are encrypted at rest, and raw messages live in files

Sources need credentials: IMAP passwords, the WebUntis QR secret, ICS URLs that are themselves secrets, and the whatsmeow session. Postgres dumps get copied, attached to bug reports and uploaded as backups, so credentials must not appear in them in clear text. A `SecretStore` port encrypts each credential with a data key, and the data keys are wrapped with a master key (envelope encryption). The master key is a file in its own volume, never written to Postgres, and created on first start.

Raw source messages and attachments, such as PDFs and images, are kept behind a `BlobStore` port. Its default implementation is the filesystem, in a data volume. Postgres holds only their metadata and content hash. Blobs make up most of the data, and in Postgres they would make dumps slow and large.

## Consequences

- A backup consists of a Postgres dump and the blob volume. The master key is not included. The Admin must keep a recovery kit, printed or saved at first start, without which a backup cannot restore Source credentials.
- Off-site backups to Agenda Cloud (ADR-0004) are encrypted on the Instance with a backup key derived from the recovery kit, so Agenda Cloud stores only ciphertext.
- Deleting a raw message deletes its blob file, which makes retention ([artkoenig/family-buttler#18](https://github.com/artkoenig/family-buttler/issues/18)) a file operation.
- The whatsmeow sidecar keeps its own session store (ADR-0002). It lives in its own volume, which is covered by the same backup and the same recovery kit.

## Considered Options

- **Credentials in plain Postgres columns, protected by disk encryption**: common in self-hosted apps, but every dump leaks them.
- **Blobs as `bytea` in Postgres**: one store and transactional, but dumps grow with every PDF and restores get slow on a Raspberry Pi.
- **An S3-compatible store (MinIO, Garage) in Compose**: one more service to run, for no gain on a single Instance.

_Amended by ADR-0011: the whatsmeow session store is replaced by the bridges' volumes, which hold the Messenger sessions outside Postgres. A backup also includes Synapse's own database and the Synapse and bridge volumes, under the same recovery kit._
