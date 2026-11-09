---
status: proposed
---

# Agendas open only through their secret Agenda Link; Admins always sign in, by password or OIDC

Family Members have no accounts. An Agenda opens only through its Agenda Link, a secret, revocable URL that an Admin creates and can rotate, whichever way the request reached the Instance: home network, reverse proxy, tunnel or a provider's hosting. The home network is not an access control, so an Instance works the same self-hosted and hosted as a service. How Agenda Links are reworked is decided separately.

The Admin area is the one place with accounts. Admins sign in with an email and a password (Argon2id), or through one OpenID Connect Identity Provider an Admin configures (issuer, client, required group), for households that already run one. Its client secret is kept in the SecretStore (ADR-0003). Password sign-in is rate-limited per account and per client.

## Considered Options

- **The home network as access control**, with open Agendas locally and links only from outside: no secret on the LAN, but the Instance cannot tell a tunnelled request from a local one, and a hosted Instance has no home network.
- **Accounts for Family Members**: children and shared kitchen screens would need passwords to read a calendar.
