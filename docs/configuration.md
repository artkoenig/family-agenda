# Configuration

How to configure the containers, the address the Family opens, and single sign-on (SSO) for Admins. Background: ADR-0001, ADR-0003, ADR-0004.

## Containers

`docker compose up -d` starts `api`, `worker`, `postgres` and `mdns`. Set variables in a `.env` file next to `compose.yaml` or in your stack tool (Portainer, ...); [`.env.example`](../.env.example) lists them all.

| Variable | Default | Purpose |
|---|---|---|
| `FAMILY_AGENDA_VERSION` | the release of your `compose.yaml` | Which release to run: a version such as `0.3.1`, `latest` for the newest release, `main` for the main branch (no guarantee that it keeps your data). Leave it unset unless you want to differ from your `compose.yaml` |
| `PORT` | `8080` | Host port of the `api` |
| `PUBLIC_URL` | `http://<MDNS_NAME>:<PORT>` | Address the Family opens. Agenda addresses and ICS links are built from it |
| `TRUST_PROXY` | `false` | `true` behind your own HTTPS reverse proxy (see below) |
| `MDNS_NAME` | `family-agenda.local` | Name the `mdns` service announces (Linux host only) |
| `POSTGRES_PASSWORD` | `family_agenda` | Change it if the port of Postgres is ever exposed |
| `TZ` | `Europe/Berlin` | Decides where an Agenda's days start |
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
- Gives `api` and `worker` that network, `PLUGIN_URLS` (`<id>=http://plugin-<id>:8080`) and `PLUGIN_EGRESS`, the declared egress hosts per container.
- Gives each plugin, and each companion with egress hosts, an egress proxy `<service>-egress` (HTTP CONNECT on port 3128, from the core image), on an internal network shared with that container alone and on the Instance's default network. The container gets `HTTPS_PROXY`/`HTTP_PROXY` pointing at it; a companion without egress hosts gets none. The proxy is the container's only way out: it allows the declared hosts and, for the plugin's own container, the hosts an Admin entered in host fields of that plugin's Sources (such as an IMAP server), on any port unless the value names one. It fetches that allowlist from the api on every connection, at `http://api:3001/egress/<service>` (not published), with a token of its own (`<SERVICE>_EGRESS_TOKEN`, such as `PLUGIN_IMAP_EGRESS_TOKEN`, in `.env`, filled by the generator), so it reads no other container's allowlist. It connects only to public addresses: a name resolving to a private, loopback or link-local address is refused, and so is a name without a dot, such as a compose service. A host field value must be a host name with an optional port (no URL, path or wildcard); otherwise it is ignored. A host `*.example.org` stands for the names below example.org. When the proxy is down or cannot fetch the allowlist, the container has no internet access.
- For a companion with `database: true`: a role and database `plugin_<id>_<name>` (UTF8, C collation; only a newly created database gets these, an existing one keeps its own) on the Instance's Postgres, created or updated by a one-shot `plugin-<id>-<name>-database` service before the companion starts, which also revokes access to it and to the core's database from every other role; a random password added to `.env` as `PLUGIN_<ID>_<NAME>_DATABASE_PASSWORD`; and `DATABASE_URL` in the companion's environment. Postgres joins a separate internal network `plugin-<id>-database` with that companion only.

## Address of the Instance

- **Home network only**: leave the defaults. `mdns` makes `http://family-agenda.local:8080` work from the home network. It needs a Linux host, not Docker Desktop.
- **Own name or HTTPS**: put a reverse proxy in front (Caddy, nginx, Tailscale serve, ...), set `PUBLIC_URL` to the address the Family uses and `TRUST_PROXY=true`.
- **Short LAN names** (for example `agenda.home`): add a DNS rewrite to the host's IP in your DNS server (AdGuard, Pi-hole, router). Avoid `.lan`, some routers answer it themselves. Let the proxy redirect that name to the public URL, or set `PUBLIC_URL` to it.

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
2. Redirect URI: `<public base URL>/sso/callback`. The settings page shows the exact value.
3. Scopes: `openid email profile groups`. The `groups` claim must be present.
4. Create a group for Admins (default name `homelab-admin`) and add the Admins. Everybody in that group can become an Admin on first sign-in, so keep it small.
5. Every user needs a **verified email**. Pocket ID v2: set "email verified" on each existing user, the global toggle only affects new users. Otherwise Family Agenda refuses the sign-in.

### In Family Agenda

1. Run behind HTTPS with `TRUST_PROXY=true` (see above).
2. Admin area, Settings, Identity Provider: enter issuer URL, client ID, client secret, required group and **public base URL** (origin only, no path), then switch it on. It saves as enabled only if the issuer's discovery document can be fetched.
3. Check that the redirect URI shown matches the client at the Identity Provider.

The Instance must reach the Identity Provider (discovery, keys, token endpoint). Outbound only.

### Who becomes an Admin

- Same `sub` as a stored Admin: signs in.
- Otherwise, an existing Admin with the same verified email is linked.
- Otherwise a new Admin without a password is created. It sees only the Recovery Kit until that is confirmed.

The group is checked at every sign-in. Leaving it does not end running sessions (14 days).

### One address for Admins

Sessions are cookies bound to **one host**. The SSO button and the SSO session exist only on the public base URL. On any other address (`family-agenda.local`, an IP, a short LAN name) there is no session after an SSO sign-in.

- Open Admin links on the public base URL. A link such as "Open the message" on an Agenda opened at `family-agenda.local` stays on that host and asks for a sign-in. Let your proxy or DNS redirect the other names to the public base URL, or use the public base URL as `PUBLIC_URL`, so Agendas link there.
- Plain Agendas and ICS feeds need no session and work on every address.
- Password sign-in works on every address, at any time.

### Locked out

- Password sign-in still works. Forgotten: another Admin or the CLI can set a new one (ADR-0004).
- Identity Provider down: use the password.
- Wrong settings blocking you: sign in with the password, switch SSO off in Settings.

## Troubleshooting

| Symptom | Cause |
|---|---|
| No SSO button on the sign-in page | Not on the public base URL, or `TRUST_PROXY` is not `true` behind HTTPS |
| SSO refused with "not in the group" | User not in the required group, or the `groups` claim is missing |
| SSO refused, email problem | Email not verified at the Identity Provider |
| Asked to sign in again on a link | Link opened on another host than the one signed in on, see "One address for Admins" |
| Agenda addresses show the wrong host | `PUBLIC_URL` is unset or still the default |
