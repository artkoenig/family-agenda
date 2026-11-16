---
status: proposed
---

# Admins exist only in the Identity Provider; the core keeps no accounts

The core no longer manages people. It stores no passwords and has no table of Admins: whoever the one OpenID Connect Identity Provider vouches for is an Admin, for as long as a session lasts. An Identity Provider is therefore required. For households that run none, the stack ships Logto as an optional container. This supersedes the password half of ADR-0004, and ADR-0007's amendments "in supplied mode, the Context names the Identity Provider" and "sign-in only for known Admins".

## Decision

- **Sign-in is OIDC only.** Password sign-in, password reset, its rate limit and Argon2id go away, as do `enter-admin`, the Triggered operation that resets a password, and the list of Admins in the Admin area. Adding or removing an Admin happens in the Identity Provider.
- **No Admin table.** A session keeps the Identity Provider's `sub`, the verified email address and its expiry. It does not reference a stored Admin. Nothing else refers to an Admin today: no Item or setting records who changed it.
- **Sessions last 12 hours**, with no refresh token. After that the browser is sent through the Identity Provider again, silently while its own session lasts. Someone removed in the Identity Provider loses access within 12 hours at most.
- **No setup page.** An empty Instance needs no first Admin. The first sign-in lands in the Admin area, and settings the setup page asked for get defaults there. The Recovery Kit is unaffected: the Admin area shows it until an Admin confirms it was saved.
- **Fixed mode: a role or group decides.** The core checks that the claim named by `OIDC_GROUPS_CLAIM` (default `groups`) contains `OIDC_REQUIRED_GROUP` (default `homelab-admin`). With Logto the claim is `roles`.
- **Supplied mode: the token names the Family.** One Identity Provider serves the whole deployment and is configured in the environment like in fixed mode. The Context no longer carries `identityProvider` or a client secret. Each Admin belongs to exactly one Family. The claim named by `OIDC_FAMILY_ID_CLAIM` (a dotted path, default `family_id`; with Logto `custom_data.familyId`) must equal the Context's Family id, and no role is checked besides. A token without it, or with another Family's id, is refused with a message saying so.
- **One callback for all Families in supplied mode.** Logto, like most providers, takes only exact redirect URIs. The deployment therefore has one fixed callback, `OIDC_CALLBACK_URL`. The core signs a short-lived `state` holding the Family id and the address to return to. After the callback it checks the Family claim against that `state`, then hands the sign-in over to the Family's `publicUrl`, where the session cookie is set. In fixed mode the callback stays below `PUBLIC_URL`.

## The optional Logto container

- **Startup.** It runs under the Compose profile `idp` (`docker compose --profile idp up`). Its own database `logto` lives on the stack's existing Postgres (Logto needs 14 or later). Its admin console is not published to the outside by default.
- **One command sets it up** and can be repeated. It:
  - creates the OIDC client (traditional web app) with its redirect URIs, and the role `homelab-admin`
  - turns self-registration off (`signInMode: SignIn`)
  - applies the sign-in branding: logo, colours, and the versioned `deploy/idp/logto-sign-in.css` as custom CSS
  - configures the SMTP connector only when `SMTP_*` is set
  - creates the first user with the role and prints a one-time password
  - prints the `OIDC_*` values for the core
- **Its Management API token** comes from a machine-to-machine app that must be created once in the Logto console with the Management API role. Logto OSS seeds none. The docs need to describe this one manual step.
- **Family id in the token (supplied mode).** It lives in the user's `customData.familyId` and reaches the ID token through Logto's `custom_data` scope, which must be enabled. Custom JWT scripts are not needed: they only add claims to access tokens.
- **Without SMTP**, a forgotten password is reset by someone in the Logto console. With it, Logto offers a reset by email code.

## Considered Options

- **Keep passwords in the core next to OIDC.** Two account systems, rate limiting, reset and recovery flows to maintain. Rejected.
- **Keep an Admin table filled from sign-ins.** It holds nothing the core uses besides the session reference. Rejected.
- **Carry the Context in the JWT instead.** The Context holds the database URL, the family key and secrets. An ID token is only signed and travels through the browser. Agenda Links, Triggered operations and Due work run without any token. The Identity Provider settings are needed before a token exists. Rejected: the Context says where a Family's data is, the token says who someone is and which Family they belong to.
- **One required group per Family in the Context.** Needs a group per Family in the Identity Provider and keeps IdP settings in every Context. Rejected for the Family claim.
- **Pocket ID as the shipped provider.** It is passkey-only, and username/password sign-in is wanted. Rejected.
- **Rauthy, Casdoor, VoidAuth, Authentik, Keycloak.** Rauthy and VoidAuth are lighter but offer less control over the sign-in page. Casdoor's admin is rough. Authentik and Keycloak are too heavy for an optional side container. Logto offers password and passkeys, custom CSS, a Management API, and reuse of the existing Postgres, under MPL-2.0.

## Consequences

- **The Identity Provider becomes a hard dependency.** If it is down, no one can sign in. Agendas keep working.
- **Instances that run no Identity Provider today must add one.** One release keeps password sign-in, marked deprecated, with a notice in the Admin area. The release after that drops it. The migrations follow ADR-0003: expand first (sessions get `subject` and `email`, and `admin_id` becomes nullable), and only once no core reads them does a contract migration drop `admin_session.admin_id` and the Admin table.
- **Removal is not immediate.** Revoking someone in the Identity Provider takes effect only when their session expires, at most 12 hours.
- **Tests and previews** use an in-process fake Identity Provider that signs tokens. Preview Instances (`pnpm preview`) use `mock-oauth2-server`, so trying a PR needs no passkeys or passwords.
- **Logto's own limits apply.** Its docs recommend generous hardware (2 vCPU, 8 GiB). Real use is expected to be far lower, but that has not been measured here. In the open-source edition, Logto's console has one console administrator without a Logto licence; household Admins are ordinary Logto users and are not limited.
- **The `OIDC_*` set changes.** New: `OIDC_GROUPS_CLAIM`, `OIDC_FAMILY_ID_CLAIM`, `OIDC_CALLBACK_URL`. Gone: `OIDC_KNOWN_ADMINS_ONLY`. In supplied mode the variables are now required rather than refused, and a Context with `identityProvider` is refused.
