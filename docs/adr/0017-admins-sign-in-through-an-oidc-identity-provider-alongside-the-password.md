---
status: proposed
---

# Admins can sign in through an OIDC identity provider, alongside the password

Amends ADR-0003 (which excluded OIDC in v1), ADR-0006 and ADR-0013.

ADR-0003 left OIDC out of v1: the Admin area is the one place that needs an account, and a password was the least that worked on a home network. Households that already run an Identity Provider, such as Pocket ID with passkeys, then keep a second password for Family Agenda. Admins can now sign in through an OIDC Identity Provider as well. The password stays.

## Decision

- **Settings.** An Admin configures one Identity Provider: an enabled switch, the issuer URL, client ID, client secret, the required group (default `homelab-admin`) and the public base URL. The client secret is stored in the SecretStore like Source credentials (ADR-0006). The scopes are fixed to `openid email profile groups`, and the flow is the authorization code flow with PKCE. Switching it on is possible only after the issuer's discovery document can be fetched; settings saved while it is off are not checked. The redirect URI, `<public base URL>/sso/callback`, is shown read-only for registering at the provider.
- **Identity mapping.** The Admin whose stored `sub` matches signs in. Otherwise the existing Admin with the same verified email is linked and the `sub` stored; an Admin already linked to another `sub` is not taken over. Otherwise a new Admin is created without a password (`admin.password_hash` becomes nullable). Another Admin, or the CLI, can set a password later. A created Admin sees only the Recovery Kit until it is confirmed, as every Admin does.
- **Group.** The required group is checked at every single sign-in. Leaving it neither deletes the Admin nor ends sessions that are running. After single sign-on the session is Family Agenda's own and lasts 14 days; there is no back-channel logout.
- **Password stays.** Password sign-in remains for everyone, with its rate limiting, and cannot be switched off. `/setup` is unchanged. The sign-in page shows both ways, but the single sign-on button only on the public base URL, where the provider's redirect can return, and not on `family-agenda.local`.
- **Reach.** The tailnet route (`ts.net`) goes to the local listener. A tailnet is household trust, and Agendas stay open as ADR-0003 has them. The remote listener of ADR-0005 stays reserved for Agenda Cloud.

## Consequences

- A person in the required group at the Identity Provider can become an Admin by signing in. The group is the access control, so it must be limited to the Admins.
- The Instance must be reachable by the Admin's browser at the public base URL, and reach the provider itself for discovery, keys and the token endpoint. This is outbound only.
- The `identity_provider` table holds at most one row, like `llm_endpoint` (ADR-0013).

## Considered Options

- **Replace the password**: simpler, but locks Admins out whenever the provider is down, and breaks the CLI recovery path.
- **Create no Admins just in time**: safer, but an Admin must then be added by hand before they can sign in with a passkey.
