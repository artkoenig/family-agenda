---
status: proposed
---

# Agendas open only through their secret Agenda Link; Admins always sign in, by password or OIDC

Family Members have no accounts. An Agenda opens only through its Agenda Link, a secret, revocable URL that an Admin creates and can rotate, whichever way the request reached the Instance: home network, reverse proxy, tunnel or a provider's hosting. The home network is not an access control, so an Instance works the same self-hosted and hosted as a service. How Agenda Links are reworked is decided separately.

An Agenda Link is built from `PUBLIC_URL`, so below a Path prefix every Agenda lies below that prefix, and so do the Admin area and its cookies.

The Admin area is the one place with accounts. Admins sign in with an email and a password (Argon2id), or through one OpenID Connect Identity Provider (issuer, client, required group), for households that already run one. The operator configures it in the environment (ADR-0007). Password sign-in is rate-limited per account and per client.

Superseded for the password part by ADR-0009: Admins exist only in the Identity Provider and sign in only through it; the core keeps no accounts and no passwords.

## Considered Options

- **The home network as access control**, with open Agendas locally and links only from outside: no secret on the LAN, but the Instance cannot tell a tunnelled request from a local one, and a hosted Instance has no home network.
- **Accounts for Family Members**: children and shared kitchen screens would need passwords to read a calendar.
