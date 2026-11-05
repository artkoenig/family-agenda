# Local-only, with open Agendas and server-rendered HTML

Family Agenda v1 can only be reached on the home network, like Home Assistant. Anyone who wants access from outside builds it themselves (a VPN, or a reverse proxy with its own authentication), or waits for a later hosted version. Because of that, the home network is the access control for Agendas. An Agenda has no secret link, no PIN and no login: anyone who reaches the server can open any Agenda and tick a Task done there. The Admin area is different. It holds Source credentials and third parties' raw messages, so Admins always sign in with their own account, on the home network too.

Without an internet-facing origin, a PWA buys little and costs HTTPS on the LAN. Service workers, Web Push and passkeys all need a secure context. So the frontend is a plain website: Hono renders HTML on the server with `hono/jsx`, and htmx adds the little interactivity needed. Next to it, a JSON REST API over the same use cases serves later native apps. This amends ADR-0002: `apps/web` is no longer a React app, and `apps/api` serves both the HTML pages and the API.

## Consequences

- Plain HTTP is the default. HTTPS is optional, through the operator's own reverse proxy, and cookies become `Secure` behind it.
- Admin sign-in is an email and a password (Argon2id), with no passkeys, OIDC, magic links or TOTP in v1. A forgotten password is reset by another Admin, or with a CLI command inside the container.
- With no PWA there is no Web Push. Notifications need a channel that works with outbound internet only.
- An ICS feed is only reachable locally, so Google Calendar can't subscribe to it.
- Anyone on the home Wi-Fi, guests included, sees the Agendas. The docs must say that guest Wi-Fi isolation helps, and that whoever exposes the server must put authentication in front of it.

## Considered Options

- **A secret link per Agenda**: needed on the internet, but on the home network it only adds rotation and device pairing.
- **A login per Family Member**: turns children into user accounts, with passwords and resets.
- **A React/Vite PWA**: offline use and Web Push, but only over HTTPS, which a LAN install doesn't have by default.

_Amended by ADR-0005: with Remote Access, requests from outside the home network arrive on a separate listener, where an Agenda opens only through its Agenda Link. Open Agendas as described here apply to the local listener only._

_Amended by ADR-0017: Admins can also sign in through an OIDC Identity Provider, such as Pocket ID with passkeys, alongside the password. v1 no longer excludes OIDC._
