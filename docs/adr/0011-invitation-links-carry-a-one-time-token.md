---
status: proposed
---

# Invitation links carry a one-time token

An invited Admin often has no account at the Identity Provider yet. Registration is closed once a Family exists (ADR-0010), so a link to the sign-in page alone leaves them stuck. The Invitation link therefore carries a one-time token from the Identity Provider. It lets the invitee create an account and sign in, while registration stays closed for everyone else.

## Decision

- **The core creates the token when an Admin invites.** It uses the management API (Logto: `POST /api/one-time-tokens` with `{ email, expiresIn }`). The token is valid until the invitation expires (7 days); Logto sets no upper bound. The port `IdentityDirectory.createSignInToken` hides this, so fakes and other providers can stand in.
- **The link goes to the core, not to the Identity Provider:** `<publicUrl>/sso/start?one_time_token=<token>&login_hint=<email>`. `/sso/start` begins sign-in as usual, with state, nonce and PKCE (and, in supplied mode, the sealed state to the one callback). It adds both parameters to the authorization URL. Logto checks the token, marks the email verified, lets a new person set a password even with `signInMode: SignIn`, and signs them in.
- **The invitation still decides.** Back at the callback, the verified email finds the pending invitation and makes the invitee an Admin, as before (ADR-0010). The token itself grants nothing in the Family.
- **No JIT organization in the token's context.** With `jitOrganizationIds`, Logto adds the user to the organization without a role. Accepting the invitation is then refused as "already a member", and the invitee never becomes an Admin.
- **Logto mails the link.** The setup gives the SMTP connector an `OrganizationInvitation` template with `{{link}}`, filled from the invitation's `messagePayload.link`. Without that template, Logto falls back to the generic code template, which has no link.
- **The token works once.** After it is used, the invitee signs in on the sign-in page like any Admin.

## Considered Options

- **Open sign-up while invitations are pending.** Anyone could register in that window. In fixed mode a stray registration creates nothing, but it still creates an account. Rejected.
- **Pre-create the invitee's account with a generated password.** That puts a password in an email or in the Admin's hands, and leaves accounts behind for invitations nobody accepts. Rejected.
- **Put the Identity Provider's authorization URL in the email directly.** The core's state, nonce and PKCE verifier live in a short-lived cookie (or sealed state) made at the start of sign-in, so a URL minted at invite time could not complete. Rejected.
- **JIT provisioning through the token.** It adds a member without the `admin` role and blocks the invitation. Rejected.
