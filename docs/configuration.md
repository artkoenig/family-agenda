# Configuration

How to configure the containers, the address the Family opens, and single sign-on (SSO) for Admins.

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
| `TZ` | `Europe/Berlin` | Decides where an Agenda's days start. Required; the time zone of the process is no longer a fallback |
| `MASTER_KEY` | none, required | 32 random bytes in base64 (`openssl rand -base64 32`) that Source credentials are encrypted with. An Instance that already has a key file in the `master-key` volume may leave it unset; Family Agenda no longer creates a key on its own |
| `PLUGIN_HOST_TOKEN` | none | A random token (`openssl rand -hex 32`) api, worker and the `plugin-host` service share. Set, the Source Types in `PLUGIN_HOST_SOURCE_TYPES` run in the Plugin Host, each in a sandboxed process of its own user without access to the database, the master key or the blobs; unset, every plugin runs in api and worker |
| `PLUGIN_HOST_URL` | `http://plugin-host:4100` in Compose | Where api and worker reach the Plugin Host; needed with `PLUGIN_HOST_TOKEN` |
| `PLUGIN_HOST_SOURCE_TYPES` | `ics` | The Source Types the Plugin Host runs, separated by commas |

Data lives in named volumes (`postgres-data`, `master-key`, `blobs`, ...). How to back them up, restore and upgrade is in [upgrading.md](upgrading.md). Keep the Recovery Kit, without it Source credentials cannot be restored.

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

- Password sign-in still works. Forgotten: another Admin or the CLI can set a new one.
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
