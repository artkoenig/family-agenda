---
status: proposed
---

# Registration creates the Family; Admins are invited through the Identity Provider

A parent can register on their own. Their registration creates a new Family, and they become its first Admin. In the cloud every registration does this. Self-hosted, only the first one does: registration then closes, and further Admins join by invitation. Since cloud Admins cannot reach the Identity Provider's console, Family Agenda gets an Admins page that invites, lists and removes Admins through the Identity Provider's management API. Both need that API; without it, nothing changes from ADR-0009 and Admins are managed in the Identity Provider itself. Each Family is an organization in the Identity Provider, and its Admins are the organization's members. This amends ADR-0009 (also its Family claim) ("turns self-registration off", "adding or removing an Admin happens in the Identity Provider") and ADR-0007 where a Family is prepared at start.

## Decision

- **A management API is optional and switches both features on.** `IDP_MANAGEMENT_API` names the adapter (`logto`, the first and only one), with `IDP_MANAGEMENT_ENDPOINT`, `IDP_MANAGEMENT_CLIENT_ID` and `IDP_MANAGEMENT_CLIENT_SECRET`. Incomplete or wrong variables stop the Instance at start, naming the variable. Without them there is no registration, no Admins page, and the core behaves as in ADR-0009. The core talks to the Identity Provider through a port (`IdentityDirectory`): create a Family's organization, add a member, invite one by email, list and remove members, list and revoke pending invitations.
- **Registration happens in the Identity Provider.** The core's sign-in page links to the Identity Provider's sign-up screen. The Identity Provider tells the core about a new user through a signed webhook (`POST /idp/events`, secret `IDP_WEBHOOK_SECRET`, Logto's `PostRegister`). The core ignores an event whose signature is wrong, whose email is not verified, or that it has seen before.
- **Email verification is required.** The Identity Provider must verify the address before the account exists; with Logto this needs the SMTP connector. Without SMTP, registration stays off and the setup command says why.
- **The core then creates the Family.** It prepares a new Family (ADR-0007's preparation, with a random Family id), creates its organization (Logto: an Organization with the role `admin`, the Family id in its `customData`), records the organization id with the Family, and adds the user as a member with that role.
- **Membership decides who is an Admin**, in both modes, whenever a management API is configured. The ID token's organizations claim (Logto: `organizations`, scope `urn:logto:scope:organizations`) must contain the Family's organization id. This replaces `OIDC_REQUIRED_GROUP` and `OIDC_FAMILY_ID_CLAIM` for such deployments. Without a management API, ADR-0009's checks stay. The user's first sign-in lands in the new Family's Admin area, with the Recovery Kit shown as before.
- **Self-hosted (fixed mode): one Family, created by the first registration.** Until then the Instance shows only sign-in and sign-up. After it, the core turns registration off in the Identity Provider (Logto: `signInMode: SignIn`). An event for a later registration that slipped through creates nothing: that user joins no organization and cannot sign in. `FAMILY_ID` still fixes the id the first registration uses. An Instance whose Family already exists never reopens registration.
- **Cloud (supplied mode): every registration creates a Family.** The core cannot seal a Context itself (ADR-0003), so it tells the platform: a signed webhook `family.created` to `FAMILY_WEBHOOK_URL` (secret `FAMILY_WEBHOOK_SECRET`) carrying the Family id and the Admin's verified email. The platform answers by supplying the Context, which prepares the Family's database on first use. Delivery is retried with backoff until the platform answers `2xx`; the Family id is the idempotency key. Without `FAMILY_WEBHOOK_URL`, supplied mode keeps registration off.
- **Admins page.** Shown in the Admin area only with a management API. It lists the Family's Admins (email, last sign-in) and pending invitations, invites one by email, revokes an invitation, and removes an Admin. Invitations are the Identity Provider's own (Logto: organization invitations): it sends the email through its connector, in the Family Language, with an accept link that expires after 7 days; the invitee registers or signs in there and becomes a member. Accepting does not create a Family: the core ignores registration events for users who arrive through an invitation. Removing the last Admin is refused. Removal takes effect at the next sign-in, at most 12 hours later (ADR-0009).
- **Still no Admin table.** The core stores only the events it has processed, for idempotency, and pending `family.created` deliveries. Who is an Admin stays in the Identity Provider.
- **Migrations follow expand/contract** (ADR-0003).

## Considered Options

- **Create the Family in the core's own sign-up form.** The core would handle passwords again, against ADR-0009. Rejected.
- **Create the Family on first sign-in instead of a webhook.** Needs registration open to anyone with an account and a claim the core does not yet have. A webhook carries the verified email and lets the core tie the user before the first sign-in. Rejected.
- **Self-hosted: a command-line command that creates the Family.** Works, but is a second path besides the cloud's. Registration gives both modes one flow. Rejected as the primary path.
- **Self-hosted: keep registration open.** Anyone reaching the Instance could become an Admin. Rejected.
- **Cloud: the platform creates the Family and invites the user.** Moves registration out of Family Agenda into every platform. Rejected.
- **Family id in the user's `customData` (as in ADR-0009) and invitations mailed by the core.** Keeps the Identity Provider neutral, but the core would send mail, keep templates and manage invitation tokens itself, and a user could belong to only one Family. Rejected for organizations.
- **Cloud: the platform polls for new Families.** Slower and needs another API. Rejected for a webhook.

## Consequences

- **The design leans on Logto's Organizations.** Another Identity Provider needs an adapter with an equivalent (Keycloak: Organizations, Authentik: groups plus an invitation flow), or it runs without a management API.
- **#418/#419 change**: with a management API the Family check reads the organizations claim, and the sealed `state` carries the organization id.
- **An Admin may belong to several Families**, since membership is a relation; the sign-in always targets the Family whose Context the request carries.
- **Logto needs SMTP** for registration and invitations. Without SMTP the ADR-0009 setup remains.
- **The management client becomes a secret of the core**, in the environment next to `OIDC_CLIENT_SECRET`. Whoever holds it can create and remove users in the Identity Provider.
- **The core depends on the Identity Provider for more than sign-in.** If its management API is down, registration events and the Admins page fail; events are retried by the Identity Provider, the page shows an error.
- **The setup command changes**: it enables registration with email verification when SMTP and `IDP_MANAGEMENT_*` are set, registers the webhook, and prints the new variables. Its first-user step stays for Instances without SMTP.
- **New variables**: `IDP_MANAGEMENT_API`, `IDP_MANAGEMENT_ENDPOINT`, `IDP_MANAGEMENT_CLIENT_ID`, `IDP_MANAGEMENT_CLIENT_SECRET`, `IDP_WEBHOOK_SECRET`, `FAMILY_WEBHOOK_URL`, `FAMILY_WEBHOOK_SECRET`.
