---
status: accepted
---

# The Identity Provider is configured by the environment, and can make the first Admin

The one OpenID Connect Identity Provider that Admins may sign in through (ADR-0004) is set by the operator in the environment, next to `PUBLIC_URL`: `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_REQUIRED_GROUP` (default `homelab-admin`). The redirect URI lies below `PUBLIC_URL`, its path prefix included. Wrong or incomplete variables stop the Instance at start, naming the variable. No Admin setting and no table hold it any more.

Because it is there before any Admin, the setup page of an empty Instance offers it too: the first one in the required group who signs in becomes the first Admin, without a password, and sees the Recovery Kit next.

Superseded in part by ADR-0009: no Admin is made or stored, the setup page and `OIDC_KNOWN_ADMINS_ONLY` are gone, and whoever is in the required group is an Admin.

Amended by ADR-0010: with a management API, the Family prepared at start has no organization yet; the first registration creates it at the Identity Provider and records its id with the Family.

## Considered Options

- **Settings in the Admin area, as before.** Needs an Admin first, so a household that wants only the Identity Provider has to create a password Admin it does not want, then enter the client secret in a form. Rejected.
- **Environment, with the settings page as an override.** Two places that can disagree. Rejected.

## Consequences

- The client secret lives in the environment of the stack tool instead of the SecretStore (ADR-0003); whoever can read the stack's variables can read it, as with `POSTGRES_PASSWORD`.
- Changing the Identity Provider means changing the variables and restarting.
- Migration `0004` drops the `identity_provider` table; an Instance that had it configured in the Admin area must set the variables. Its stored client secret is left to the worker's sweep.

## Amendment: in supplied mode, the Context names the Identity Provider

Superseded by ADR-0009: in supplied mode the one Identity Provider comes from the `OIDC_*` variables, a Context carrying `identityProvider` is refused, and the Family claim `OIDC_FAMILY_ID_CLAIM` decides who signs in.

In fixed mode the environment remains where the Identity Provider comes from, as above. In supplied mode (ADR-0003) a core serves many Families, so each Family's Context carries its own: `identityProvider` with `issuerUrl`, `clientId`, `clientSecret` and `requiredGroup` (default `homelab-admin`), the redirect URI below the Context's `publicUrl`, its path prefix included. The same rules apply as to the `OIDC_*` variables: a Context with incomplete or wrong settings is refused with `400`, naming what is wrong (`identityProvider.clientSecret must be set when identityProvider.issuerUrl is`), and a Context without `identityProvider` offers no single sign-on. The environment's `OIDC_*` variables are refused in supplied mode, so that no Family gets another's Identity Provider by accident. The client secret then lives with the trusted caller that seals the Context and travels encrypted in it; it is never logged or named in a refusal.

## Amendment: sign-in only for known Admins

Superseded by ADR-0009: no Admin is stored, and `OIDC_KNOWN_ADMINS_ONLY` is gone.

Making an Admin of anyone in the required group fits a household's own Identity Provider. It does not fit one Identity Provider shared by several Families: everyone in its group could become an Admin of any Family. The Identity Provider settings therefore gain a switch, `OIDC_KNOWN_ADMINS_ONLY` in fixed mode and `identityProvider.knownAdminsOnly` in a Context, parsed by the same rules (`true` or `false`, anything else refused naming it), off by default. With it, someone in the required group signs in only as an Admin who already exists: the one tied to their `sub`, or else the one with their verified email address, which is then tied to the identity as before; an Admin already tied to another identity is not re-tied. Anyone else is refused with a message that says no Admin of the Family has the address the Identity Provider verified for them, and no Admin is made, not even the first: the setup page then offers no single sign-on. Who is an Admin of a Family is decided in that Family alone, by entering its first Admin (`enter-admin`, or the setup page with a password) and by its Admins adding more in the Admin area, where a password may be left empty for an Admin who signs in only through the Identity Provider. Like the rest of the Identity Provider settings, the switch comes from the environment in fixed mode and from the Context in supplied mode. Without the switch the behaviour stays as above.
