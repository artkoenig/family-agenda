---
status: proposed
---

# WhatsApp is read through Baileys inside the worker, without a Go sidecar

The WhatsApp Source Type reads groups through [Baileys](https://github.com/WhiskeySockets/Baileys) instead of whatsmeow. Baileys is a TypeScript library that speaks the WhatsApp Web protocol over a WebSocket and links as a device, just as whatsmeow does. ADR-0001 stays as it is: a receive-only linked device on an Admin's personal account, opt-in, with the account risk accepted explicitly. Only the library and where it runs change. We chose this because the Go sidecar was the only reason for a second language, a second build and a Compose service of its own (ADR-0002). With Source Types as plugins (ADR-0010), a TypeScript client can be an ordinary plugin like the other three.

`packages/source-whatsapp` runs Baileys in the `worker` process. The plugin holds the connection, drops messages from groups that are not allow-listed, and emits the rest as Origins with raw messages. It never hands the Baileys socket to code outside the plugin.

## Rules

- **Receive only**: the plugin connects with `markOnlineOnConnect: false` and never calls Baileys' sending, read-receipt or presence functions (`sendMessage`, `readMessages`, `sendPresenceUpdate`). A lint rule in the package forbids those calls, so the ADR-0001 promise does not rest on review alone.
- **Session**: the Baileys auth state (credentials and Signal keys) is stored through the SDK as secret Source state, encrypted by the `SecretStore` (ADR-0006). The plugin implements its own auth state store on top of it, as Baileys recommends for production, and does not use `useMultiFileAuthState`.
- **One connection**: a WhatsApp Source has at most one open connection. The worker that holds it takes a lease in Postgres, so a second worker or a restart cannot link a second session.
- **Pairing**: the wizard's setup step (ADR-0010) shows Baileys' QR code. The pairing code is the fallback for an Admin who opens the wizard on the same phone.
- **Backfill and deletions**: the 14 days of backfill come from WhatsApp's history sync after linking. A message revoked by its sender rejects its Revisions and deletes its raw message, as before (ADR-0009, [How long are raw source messages kept?](https://github.com/artkoenig/family-buttler/issues/18)).
- **Logout**: when WhatsApp ends the linked session, the Source goes Failing with a definite error, and the Fix button repeats the pairing step ([How do Admins find out that a Source has broken?](https://github.com/artkoenig/family-buttler/issues/25)).

## Consequences

- The Instance is TypeScript only. Compose runs `api`, `worker` and `postgres`, with no sidecar service, no Go build and no session volume of its own.
- ADR-0010 needs a third ingestion mode besides polling and push: a long-lived connection, which the worker opens per Source and keeps open while the Source Type is enabled.
- Baileys reverse-engineers a protocol WhatsApp changes without notice, and its major versions break their API (7.0.0 did). The plugin pins an exact Baileys version, and updates go through the plugin's own tests against recorded protocol fixtures. whatsmeow has a longer record as the base of mautrix-whatsapp; we give that up for one language.
- Baileys is MIT-licensed, which is compatible with the AGPLv3 (ADR-0008).
- Baileys runs in the same process as the other plugins and the extraction jobs. A crash or a memory leak in it affects the whole worker, so the worker restarts the connection with a backoff and the Source status shows the failures.
- The Admin's account risk is unchanged: it is the same kind of linked device, on the same residential connection, and it never sends.

## Considered Options

- **Keep the whatsmeow sidecar**: the more proven library, and isolated in its own process, but a second language, a webhook between sidecar and Instance, and a session store outside the `SecretStore`.
- **WAHA as a container with a REST API**: the least code to write, but another container to run, and its free Core edition is limited to one session.
- **Baileys in its own Node.js container**: isolates crashes, but brings back the extra service and the webhook that dropping the sidecar was meant to remove.
