---
status: accepted
---

# The Identity Provider is configured by the environment, and can make the first Admin

The one OpenID Connect Identity Provider that Admins may sign in through (ADR-0004) is set by the operator in the environment, next to `PUBLIC_URL`: `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_REQUIRED_GROUP` (default `homelab-admin`). The redirect URI lies below `PUBLIC_URL`. Wrong or incomplete variables stop the Instance at start, naming the variable. No Admin setting and no table hold it any more.

Because it is there before any Admin, the setup page of an empty Instance offers it too: the first one in the required group who signs in becomes the first Admin, without a password, and sees the Recovery Kit next.

## Considered Options

- **Settings in the Admin area, as before.** Needs an Admin first, so a household that wants only the Identity Provider has to create a password Admin it does not want, then enter the client secret in a form. Rejected.
- **Environment, with the settings page as an override.** Two places that can disagree. Rejected.

## Consequences

- The client secret lives in the environment of the stack tool instead of the SecretStore (ADR-0003); whoever can read the stack's variables can read it, as with `POSTGRES_PASSWORD`.
- Changing the Identity Provider means changing the variables and restarting.
- Migration `0004` drops the `identity_provider` table; an Instance that had it configured in the Admin area must set the variables. Its stored client secret is left to the worker's sweep.
