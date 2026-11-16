# Configuration

How to configure the containers, the address the Family opens, and single sign-on (SSO) for Admins. Background: ADR-0001, ADR-0003, ADR-0004.

## Containers

`docker compose up -d` starts `api`, `worker`, `postgres` and `mdns`. Set variables in a `.env` file next to `compose.yaml` or in your stack tool (Portainer, ...); [`.env.example`](../.env.example) lists them all.

| Variable | Default | Purpose |
|---|---|---|
| `FAMILY_AGENDA_VERSION` | the release of your `compose.yaml` | Which release to run: a version such as `0.3.1`, `latest` for the newest release, `main` for the main branch (no guarantee that it keeps your data). Leave it unset unless you want to differ from your `compose.yaml` |
| `PORT` | `8080` | Host port of the `api` |
| `PUBLIC_URL` | `http://<MDNS_NAME>:<PORT>` | Address the Family opens. Agenda addresses and ICS links are built from it. A path, such as `https://home.example.org/agenda`, is the path prefix (see below) |
| `TRUST_PROXY` | `false` | `true` behind your own HTTPS reverse proxy (see below) |
| `MDNS_NAME` | `family-agenda.local` | Name the `mdns` service announces (Linux host only) |
| `POSTGRES_PASSWORD` | `family_agenda` | Change it if the port of Postgres is ever exposed |
| `TZ` | `Europe/Berlin` | Decides where an Agenda's days start |
| `TRIGGER_TOKEN` | generated with `compose.plugins.yaml` | Token the [Triggered operations](#triggered-operations) require as `Authorization: Bearer <token>`. Empty, the `api` does not offer them |
| `FAMILY_ID` | empty | The [Family id](#preparing-the-family) a new database gets on the first start, a UUID; empty, a random one. A database that already holds another one is refused at start |
| `TRIGGER_PORT` | `3001` | Port of the Triggered operations inside the `api` container; not published |
| `CONTEXT_MODE` | `fixed` | `fixed` serves the one Family these variables name; `supplied` serves the Family whose Context each request carries (see [Supplied mode](#supplied-mode)) |
| `CONTEXT_KEY` | empty | The key Contexts are sealed with in supplied mode, 32 characters or more; set only with `CONTEXT_MODE=supplied` |
| `CALLER_PORT` | none | In supplied mode, required: the only port the core listens on, for the trusted caller; must differ from `PORT` and is never published |
| `PLUGIN_URLS` | empty | Plugin containers (ADR-0001): `id=url` pairs separated by commas, such as `school-portal=http://school-portal:8080`. The core polls each over REST; one that does not answer shows as "Not reachable" in the Admin area. Set by `compose.plugins.yaml` (see [Plugins](#plugins)); by hand only without one |

Data lives in named volumes (`postgres-data`, `master-key`, `blobs`, ...). How to back them up, restore and upgrade is in [upgrading.md](upgrading.md). Keep the Recovery Kit, without it Source credentials cannot be restored (ADR-0003).

## Plugins

Each Source Type runs as a plugin container (ADR-0001). List them in `plugins.yml` next to `compose.yaml`; [`plugins.schema.json`](../plugins.schema.json) is its JSON schema. The repository ships a default [`plugins.yml`](../plugins.yml) with the plugins that come with the app (ICS, IMAP, WebUntis, Matrix with Synapse and the WhatsApp bridge), their images pinned and kept up to date by Renovate; copy it next to `compose.yaml`, drop the ones you do not need, and add the egress hosts your Sources need (the ICS plugin has none by default). Your copy is not versioned.

```yaml
plugins:
  - id: school-portal                          # the Source Type id the plugin reports
    image: ghcr.io/example/school-portal:1.2.0 # pinned: a tag other than latest, or a digest
    egress: [portal.example.com:443, "*.example.org:443"]
    limits: { memory: 512m, cpus: 1 }          # optional; these are the defaults
    volumes: { config: /config }               # optional, as for companions: such as configuration the plugin writes for a companion
    companions:                                # optional containers the plugin needs
      - name: synapse
        image: matrixdotorg/synapse:v1.163.2
        env: { SYNAPSE_SERVER_NAME: family-agenda }
        volumes: { data: /data }               # logical name: path, kept in volume plugin-<id>-<name>, shared by the plugin and its companions
        entrypoint: [sh, -c, "exec run"]       # optional: replaces the image's entrypoint
        command: [run]                         # optional
        egress: []                             # the companion's own hosts
        database: true                         # optional: its own database on the Instance's Postgres
        healthcheck: { test: [CMD, curl, -f, "http://localhost:8008/health"] } # optional, passed through
```

Then generate `compose.plugins.yaml` and activate it:

```sh
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD:/deployment" api plugins generate
echo "COMPOSE_FILE=compose.yaml:compose.plugins.yaml" >> .env
docker compose up -d
```

The generator validates `plugins.yml` and names every mistake, including two declarations that would make the same service, network, volume or database name. Only this one-shot run mounts the directory, at `/deployment`; `--user` lets it write there as you rather than as the image's user (uid 1000). Run it again after every change to `plugins.yml`. The first time, `COMPOSE_FILE` must not yet name the missing `compose.plugins.yaml`. The core never reads `plugins.yml`, only what the generated file sets.

What the generated file does:

- Runs plugin `<id>` as service `plugin-<id>` and each companion as `plugin-<id>-<name>`, on an internal network `plugin-<id>` without published ports, with `restart: unless-stopped`. Plugins get the limits above; there are no health checks for plugins.
- Gives `api` and `worker` that network, `PLUGIN_URLS` (`<id>=http://plugin-<id>:8080`) and `EGRESS_TICKET_KEY`, the key they sign the tickets of plugin calls with. The generator adds a random key to `.env` the first time, and a random `TRIGGER_TOKEN` for the [Triggered operations](#triggered-operations).
- Gives each plugin, and each companion with egress hosts, an egress proxy `<service>-egress` (HTTP CONNECT on port 3128, from the core image), on an internal network shared with that container alone and on the Instance's default network. The container gets `HTTPS_PROXY`/`HTTP_PROXY` pointing at it; a companion without egress hosts gets none. The proxy is the container's only way out. It connects only to public addresses: a name resolving to a private, loopback or link-local address is refused, and so is a name without a dot, such as a compose service. A host `*.example.org` stands for the names below example.org. Each proxy has its container's declared hosts in `EGRESS_HOSTS`; a plugin's own proxy also has the plugin it serves in `EGRESS_PLUGIN` and `EGRESS_TICKET_KEY`. When the proxy is down, the container has no internet access.
  - A plugin's own proxy lets a connection through only with the ticket of a call of the core (plugin contract 3.0). Each call for a Source, and the call for the Catalogue entries, hands the plugin a proxy URL, `http://ticket:<ticket>@plugin-<id>-egress:3128`; the ticket names the Family and the Source (none for the Catalogue entries), expires shortly after the call's timeout, and is signed with `EGRESS_TICKET_KEY`, which the proxy shares. A connection without it, such as through the bare `HTTPS_PROXY`, or with an expired or forged one, or one minted for another plugin, gets `407`. For a valid one the proxy decides alone, asking nobody: it lets through the plugin's declared hosts plus the hosts an Admin entered in host fields of that one Source, as the ticket carries them, if the ticket names one (such as an IMAP server, or the host of a secret calendar address), on any port unless the value names one. A host field value must be a host name with an optional port (a pasted URL counts as its host; no wildcard); otherwise it is ignored. A change to a host field reaches a call under way when its ticket expires, at most the call's timeout plus 30 seconds later; a change to the declared hosts in `plugins.yml` takes effect when you generate the file again and the proxy restarts. Any other host gets `403`, as does one resolving to an internal address; one that does not resolve gets `502`.
  - A companion's proxy allows its declared hosts, which it has in its own environment (`EGRESS_HOSTS`); the core never calls a companion.
- For a companion with `database: true`: a role and database `plugin_<id>_<name>` (UTF8, C collation; only a newly created database gets these, an existing one keeps its own) on the Instance's Postgres, created or updated by a one-shot `plugin-<id>-<name>-database` service before the companion starts, which also revokes access to it and to the core's database from every other role; a random password added to `.env` as `PLUGIN_<ID>_<NAME>_DATABASE_PASSWORD`; and `DATABASE_URL` in the companion's environment. Postgres joins a separate internal network `plugin-<id>-database` with that companion only.

## Triggered operations

The `worker` runs the Family's Due work, the purge and the secret sweep from its schedules. The same operations are offered as Triggered operations on an interface of their own, so that a scheduler of your own (cron, a home automation, ...) can run them instead of, or besides, the `worker`. On an Instance with its one Family they act on that Family; in [supplied mode](#supplied-mode), on the Family whose Context each trigger carries.

The `api` serves them on port `3001` (`TRIGGER_PORT`), which `compose.yaml` does not publish; the port that serves the pages offers none of them. It does so only while `TRIGGER_TOKEN` is set, and every request must carry `Authorization: Bearer <TRIGGER_TOKEN>`, otherwise the answer is `401`. Without a token the `api` logs once that Triggered operations are off. Generating `compose.plugins.yaml` adds a random `TRIGGER_TOKEN` to `.env` the first time, next to `EGRESS_TICKET_KEY`; without plugins, set one yourself (32 random characters or more). The token is required because the port being unpublished is no protection on its own: every plugin container shares a network with the `api`.

Reach the port from a container on the Instance's network, such as `docker compose exec api node -e "fetch('http://localhost:3001/operations/due-work', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.TRIGGER_TOKEN } }).then(async (r) => console.log(await r.text()))"`, or publish it yourself in a `compose.override.yaml` bound to `127.0.0.1` only.

| Request | Does | Answers |
|---|---|---|
| `GET /operations` | lists the operations | `{ "operations": ["due-work", "purge", "secret-sweep", "enter-admin", "reset-admin-password"] }` |
| `POST /operations/due-work` | Due work: polls the due Sources, then extracts the messages they and earlier runs brought in (Extraction runs even when polling fails) | `{ "polled": …, "extracted": … }`, each `{ "ok": true, "report": … }` with what ran and what failed, or `{ "ok": false, "error": "<message>" }` |
| `POST /operations/purge` | deletes the text and attachments of messages past their retention | `{ "purged": <messages>, "deleted": <rows deleted> }` |
| `POST /operations/secret-sweep` | removes secrets nothing refers to (older than an hour) | `{ "removed": <secrets> }` |
| `POST /operations/enter-admin` | enters an Admin by email address, without a password (see [Admins without signing in](#admins-without-signing-in)); the body is `{ "email": "<address>" }` | `{ "email": "<address>", "outcome": "first" }` for the Family's first Admin, `"added"` for one more, `"exists"` when an Admin already has that address, which changes nothing; `400` `{ "error": "invalid-email" }` for an address that is no email address |
| `POST /operations/reset-admin-password` | gives the Admin with that email a new random password and ends their sessions; the body is `{ "email": "<address>" }` | `{ "email": "<address>", "newPassword": "<password>" }`, the only place the password appears; `404` `{ "error": "unknown-admin" }` when no Admin has it, `400` `{ "error": "invalid-email" }` for an address that is no email address |

Each operation calls exactly what the `worker`'s schedule calls (`due-work` every minute, `purge` hourly, `secret-sweep` at start and nightly), and writes the same lines to the `api` log as the `worker` writes to its own. A `due-work` trigger that arrives while one is under way in the same `api` waits for that run and gets its answer; across containers, and alongside the `worker`, runs of one Source take turns in the database, so no Source runs twice at once. An unknown operation answers `404`, one that fails `500` (the `api` log has the error), a body that is no JSON `400` `{ "error": "invalid-body" }`. Preparing the Family is no Triggered operation: the core does it on its own, when it starts or, in supplied mode, when it opens a Family (see [Preparing the Family](#preparing-the-family)).

### Admins without signing in

Two operations act on the Admins for an operator who does not sign in to the Family, each both a Triggered operation and a command in the `api` container:

```sh
docker compose exec api family-agenda enter-admin anna@example.org
docker compose exec api family-agenda reset-admin-password anna@example.org
```

- **Entering an Admin** adds one with that email address and no password. On a Family without Admins it is the first one, and the setup page is gone afterwards, as after any first Admin. The Admin then signs in through the Identity Provider, which links its identity to the Admin with the same verified email address (see [Who becomes an Admin](#who-becomes-an-admin)), or gets a password through the reset; until then no password signs them in. An address an Admin already has changes nothing, and the answer says so.
- **Resetting a password** gives the Admin a new random password, shown once in the answer or the command's output and never logged, and ends their sessions.

### Preparing the Family

Preparing the Family brings its database schema up to date, makes sure it has its Family id, records the Source Types seen for the first time as disabled, and migrates the configuration of the Sources of enabled Source Types. The `api` and the `worker` do it every time they start; a core in [supplied mode](#supplied-mode) does it when it opens a Family whose database this release has not prepared. Nothing else triggers it, and running it again changes nothing. Containers starting together take turns: the schema is migrated, and the Family id written, under one lock in Postgres.

- **Family id.** A database that has none yet, an empty one, gets the id named, from `FAMILY_ID` at start (in supplied mode, the Context's), or a random UUID without one. A database that holds another id is refused before anything changes: the `api` and `worker` do not start. To make an empty database usable with an id of your choosing, set `FAMILY_ID` before the first start.
- **Versions.** A database from before the rebuild of the data model, or one a newer release migrated, is refused as at start ([upgrading.md](upgrading.md)).
- **After an upgrade**, the containers prepare the Family when they start again.

## Supplied mode

For a provider serving many Families, not for a home Instance. With `CONTEXT_MODE=supplied` the core has no Family of its own: every request carries the **Context** of the Family it is for, and the core opens that Family's database, reads its Source credentials with its family key and keeps its blobs in its folder of the blob location (ADR-0003). Any core can then serve any Family, and one core several, each in its own database.

- **Setting it.** `CONTEXT_MODE=supplied`, `CONTEXT_KEY`, 32 random characters or more, which only the core and the trusted caller in front of it hold, and `CALLER_PORT`, other than `PORT`. The core then opens no listener on `PORT`, only on `CALLER_PORT`. The core refuses to start in supplied mode without `CONTEXT_KEY`, with `CONTEXT_KEY` but without `CONTEXT_MODE=supplied`, and with `DATABASE_URL`, `FAMILY_ID`, `MASTER_KEY_FILE` or `BLOB_DIRECTORY` set: it never falls back to a fixed Family. The `worker` and the `family-agenda` Admin commands run in fixed mode only: a core in supplied mode runs no schedule and prepares no Family when it starts, but each when it opens it (see [Triggered operations in supplied mode](#triggered-operations-in-supplied-mode)). `PUBLIC_URL` and the `OIDC_*` variables are refused too: each Family's Context carries its own time zone, public address and Identity Provider instead. `TZ` only sets the time zone of the core's own log.
- **The Context.** JSON with the Family id (a UUID), the database (a Postgres URL), the family key (32 random bytes in base64url, which stands in for the master key file), the blob location (a directory; the Family's blobs lie in its folder `<directory>/<family id>`), the Family's time zone (`timeZone`, required, an IANA name such as `Europe/Berlin`, as `TZ` in fixed mode), its public address (`publicUrl`, required, as `PUBLIC_URL`: its path is the Family's path prefix, which the caller removes from a request before it passes it on, and the core emits every link, redirect, cookie, web manifest, Agenda feed and the SSO redirect URI below it) and, optionally, its Identity Provider (`identityProvider`: `issuerUrl`, `clientId`, `clientSecret`, `requiredGroup`, `knownAdminsOnly` (a boolean), as the `OIDC_*` variables; without it, no SSO), plus an expiry, encrypted and signed with AES-256-GCM under a key derived from `CONTEXT_KEY`. Seal one with `family-agenda seal-context`, which reads it from standard input so that no secret appears in a process list, for 5 minutes unless `ttlSeconds` says otherwise, at most a day:

  ```sh
  echo '{"familyId":"…","databaseUrl":"postgres://…","familyKey":"…","blobDirectory":"/var/lib/blobs","timeZone":"Europe/Berlin","publicUrl":"https://agenda.example.org/family-a","ttlSeconds":300}' \
    | CONTEXT_KEY=… family-agenda seal-context
  ```

  A caller of its own seals the same format: `v1.<iv>.<ciphertext>.<tag>`, each base64url, AES-256-GCM with a 12-byte IV and a 16-byte tag, additional data `family-agenda context v1`, the key HKDF-SHA-256 of `CONTEXT_KEY` with salt `family-agenda` and info `context v1 aes-256-gcm`, the plaintext `{ familyId, databaseUrl, familyKey, blobDirectory, timeZone, publicUrl, identityProvider?, expiresAt }` with `expiresAt` in milliseconds since the epoch.
- **Where it goes.** In the header `X-Family-Context` of every request to the caller port, and nowhere else. The core removes it before the Family's pages see the request. Without a valid one, or with an expired (beyond 30 seconds of skew), altered or foreign one, or one expiring more than a day ahead, the answer is `401` and nothing is opened; a Context whose Family id differs from the one its database holds gets `403`; a database that a newer release migrated `409` (`migrated-by-newer-release`), and one of the data model before its rebuild `409` (`old-data-model`), and nothing is written to either; a database that cannot be reached `503` (`unavailable`); a Context with settings the core does not take, such as an unknown time zone or an `identityProvider` without `clientSecret`, `400`, naming what is wrong as the environment variables are named in fixed mode (`seal-context` refuses to seal it, with the same message). Only `/api/health` answers without a Context.
- <a id="preparing-on-opening"></a>**Preparing on opening.** A caller needs no step of its own before a core serves a new or upgraded Family. The first request or trigger with a Context whose database this release has not prepared, an empty one or one an older release prepared, prepares it with the Context's Family id (see [Preparing the Family](#preparing-the-family)) and is then served as usual. It moves no blobs: the blob location is shared, and blobs of the earlier layout belong to the upgrade of a fixed Instance. Requests that open the same database meanwhile wait for that one prepare; across cores, the migration lock in Postgres lets them take turns, so nothing is prepared twice. A request waits for preparing up to 20 seconds, and is then answered `503` (`migrating`) while preparing goes on; a retry is served once it is done. Opening a database already prepared by this release migrates nothing; it only records the Source Types seen for the first time, as starting does in fixed mode. During a rolling update, a core of an older release refuses a database a newer one migrated with `409` (`migrated-by-newer-release`) and writes nothing, so the caller can send the request to another core.
- **Deployment assumption.** The caller port of a core in supplied mode is reachable from the trusted caller only, on a network of their own, and never published to browsers. Browsers reach the caller, which signs them in, decides their Family, seals its Context and forwards the request; a browser never sees a Context.
- **What the core keeps.** An opened Family, its database connections and wiring, stays in memory for 5 minutes after its last request and is then closed; idle database connections close after 10 seconds. An opened Family is kept per Family and per the settings of its Context: a Context with another `publicUrl`, time zone or Identity Provider opens it anew. SSO is offered only where the request reaches the core at the Context's `publicUrl`, so the caller passes on the browser's host (with `TRUST_PROXY=true`, in `X-Forwarded-Host` and `X-Forwarded-Proto`). No Context, family key, client secret or database password is written to disk or to the log.
- <a id="triggered-operations-in-supplied-mode"></a>**Triggered operations in supplied mode.** With `TRIGGER_TOKEN` set, the core also listens on `TRIGGER_PORT`, never published, for the [Triggered operations](#triggered-operations). Each trigger carries both `Authorization: Bearer <TRIGGER_TOKEN>`, which guards the port and is checked first, and the Context of the Family it acts on in `X-Family-Context`, which picks the Family. Each operation opens the Family as a page request does, [preparing it](#preparing-on-opening) first where this release has not, and shares an opened Family with the pages of the same Context; the plugin calls of `due-work` are ticketed for the Context's Family, and a `due-work` trigger during a run for the same database waits for that run. Without `TRIGGER_TOKEN`, the core logs once that the Triggered operations are off. The refusals, each of which changes nothing:

  | Answer | When |
  |---|---|
  | `401` `{ "error": "unauthorized" }` | without the token |
  | `401` `{ "error": "invalid-context" }` | without a valid Context |
  | `400` `{ "error": "invalid-context", "problem": "…" }` | a Context with settings the core does not take |
  | `403` `{ "error": "family-id-differs" }` | a Context whose Family id differs from the one its database holds: the Context is not allowed to that database |
  | `409` `{ "error": "migrated-by-newer-release" }` | a database a newer release migrated: another core, of that release, may run it |
  | `409` `{ "error": "old-data-model" }` | a database from before the rebuild of the data model |
  | `503` `{ "error": "migrating" }` | a database being prepared for longer than the trigger waits: try again shortly |
  | `503` `{ "error": "unavailable" }` | a database that cannot be reached |

## Address of the Instance

- **Home network only**: leave the defaults. `mdns` makes `http://family-agenda.local:8080` work from the home network. It needs a Linux host, not Docker Desktop.
- **Own name or HTTPS**: put a reverse proxy in front (Caddy, nginx, Tailscale serve, ...), set `PUBLIC_URL` to the address the Family uses and `TRUST_PROXY=true`.
- **Short LAN names** (for example `agenda.home`): add a DNS rewrite to the host's IP in your DNS server (AdGuard, Pi-hole, router). Avoid `.lan`, some routers answer it themselves. Let the proxy redirect that name to the public URL, or set `PUBLIC_URL` to it.

### Below a path prefix

To serve the Instance below a path such as `/agenda`, set `PUBLIC_URL` with that path (`https://home.example.org/agenda`) and let the proxy remove the prefix before it passes a request on. The `api` itself still listens at the root; its health check (`/api/health`) answers there, without the prefix. Session and SSO cookies are limited to the prefix, and the SSO redirect URI lies below it. A `PUBLIC_URL` without a path means no prefix.

Every page, form, background request, redirect and file the Instance serves then lies below the prefix: the Admin area at `https://home.example.org/agenda/admin`, an Agenda Link at `https://home.example.org/agenda/agendas/<id>`. The proxy must strip exactly the prefix; with Caddy, for example:

```
home.example.org {
	handle_path /agenda/* {
		reverse_proxy family-agenda:8080
	}
}
```

With nginx, `location /agenda/ { proxy_pass http://family-agenda:8080/; }` does the same (the trailing slash of `proxy_pass` removes the prefix). Set `TRUST_PROXY=true` as for any proxy. These match `/agenda/` and below; redirect the bare `/agenda` to `/agenda/` in the proxy if the Family may type it.

`PUBLIC_URL` is the address shown and copied from the Agendas page and used in ICS feeds. Calendar apps need to reach it, and some do not follow an HTTP to HTTPS redirect, so point `PUBLIC_URL` at the final address where you can.

### `TRUST_PROXY`

Set `TRUST_PROXY=true` only behind a proxy you run, which sets `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For`. Effects:

- The app sees the real scheme and host. Without it, behind an HTTPS proxy it sees `http://` and offers no SSO button.
- Session cookies become `Secure` on HTTPS.
- `X-Forwarded-For` is trusted for sign-in rate limiting. Do not expose the `api` port directly with this on.

## Single sign-on (OIDC)

Admins can sign in through an OIDC Identity Provider (Pocket ID, Authentik, Authelia, ...). The password stays and cannot be switched off.

### At the Identity Provider

1. Create a client for Family Agenda. Authorization code flow with PKCE.
2. Redirect URI: `<PUBLIC_URL>/sso/callback`.
3. Scopes: `openid email profile groups`. The `groups` claim must be present.
4. Create a group for Admins (default name `homelab-admin`) and add the Admins. Everybody in that group can become an Admin on first sign-in, so keep it small.
5. Every user needs a **verified email**. Pocket ID v2: set "email verified" on each existing user, the global toggle only affects new users. Otherwise Family Agenda refuses the sign-in.

### In Family Agenda

Set these variables (ADR-0007) and restart. Wrong or missing ones stop the Instance at start, naming the variable.

| Variable | |
|---|---|
| `OIDC_ISSUER_URL` | Issuer URL; discovery finds the rest. Unset: no SSO |
| `OIDC_CLIENT_ID` | Client ID |
| `OIDC_CLIENT_SECRET` | Client secret |
| `OIDC_REQUIRED_GROUP` | Group whose members may sign in. Default `homelab-admin` |
| `OIDC_KNOWN_ADMINS_ONLY` | `true`: only an existing Admin signs in, none is made from a sign-in (see [Who becomes an Admin](#who-becomes-an-admin)). Default `false` |
| `PUBLIC_URL` | Required. The SSO button appears only there; a path in it, the path prefix, is part of the redirect URI |

Behind HTTPS also set `TRUST_PROXY=true` (see above).

On an Instance without Admins the setup page offers SSO too: the first one in the group who signs in becomes the first Admin, without a password. Not with `OIDC_KNOWN_ADMINS_ONLY=true`.

The Instance must reach the Identity Provider (discovery, keys, token endpoint). Outbound only.

### Who becomes an Admin

- Same `sub` as a stored Admin: signs in.
- Otherwise, an existing Admin with the same verified email is linked.
- Otherwise a new Admin without a password is created. It sees only the Recovery Kit until that is confirmed.

With `OIDC_KNOWN_ADMINS_ONLY=true` (in a Context, `identityProvider.knownAdminsOnly: true`) the last step is gone: someone in the group whose verified email belongs to no Admin is refused, told that no Admin here has that address, and no Admin is made, not even the first. Use it for one Identity Provider shared by several Families, where everyone in its group could otherwise become an Admin of any Family. Who is an Admin is then decided in the Family alone: its first Admin is entered by email address ([`enter-admin`](#admins-without-signing-in)) or set up with a password, and its Admins add more in the Admin area, by email address with the password left empty for one who signs in only through the Identity Provider.

The group is checked at every sign-in. Leaving it does not end running sessions (14 days).

### One address for Admins

Sessions are cookies bound to **one host**. The SSO button and the SSO session exist only on `PUBLIC_URL`. On any other address (`family-agenda.local`, an IP, a short LAN name) there is no session after an SSO sign-in.

- Open Admin links on `PUBLIC_URL`. A link such as "Open the message" on an Agenda opened at another host stays on that host and asks for a sign-in. Let your proxy or DNS redirect the other names to `PUBLIC_URL`.
- Plain Agendas and ICS feeds need no session and work on every address.
- Password sign-in works on every address, at any time.

### Locked out

- Password sign-in still works. Forgotten: another Admin can set a new one, or the operator resets it (ADR-0004; [`reset-admin-password`](#admins-without-signing-in)).
- Identity Provider down: use the password.
- Wrong settings: fix or unset the `OIDC_*` variables and restart.

## Troubleshooting

| Symptom | Cause |
|---|---|
| No SSO button on the sign-in page | `OIDC_ISSUER_URL` unset, not on `PUBLIC_URL`, or `TRUST_PROXY` is not `true` behind HTTPS |
| SSO refused with "not in the group" | User not in the required group, or the `groups` claim is missing |
| SSO refused, email problem | Email not verified at the Identity Provider |
| Asked to sign in again on a link | Link opened on another host than the one signed in on, see "One address for Admins" |
| Agenda addresses show the wrong host | `PUBLIC_URL` is unset or still the default |
