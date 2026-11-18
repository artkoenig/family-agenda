// Inviting an Admin (ADR-0010, ADR-0011): an Admin invites an email, the core creates a one-time
// token for it and has the Identity Provider (Logto) mail the link; the invitee follows the link,
// maybe twice in two tabs, or signs in with a password later; at the callback the verified email
// finds the pending invitation, and accepting it makes the invitee a member with the role `admin`.
// Meanwhile another Admin may revoke the invitation, invite again, or remove an Admin, and the
// invitation expires.
//
// Each action is one call of the core to the management API or one step of the Identity Provider,
// so that the checker interleaves them as the network may. What Logto does in one transaction is one
// action here; this spec relies on it (logto-io/logto: OrganizationInvitationLibrary):
//   - accepting locks the invitation, refuses one that is Accepted, Revoked or past its expiry
//     (status computed at read), and adds the member and the invitation's roles in that transaction;
//   - revoking locks it the same way and refuses an ending status;
//   - an organization has at most one Pending invitation per invitee (a unique partial index; an
//     expired one is marked Expired first), so a second insert fails.
//
// Admins page (application: family-admins.ts):
//   inviteCheck  `invite`: listMembers + listInvitations, refusing an Admin or one already invited;
//                then createSignInToken (Logto: POST /api/one-time-tokens) for the expiry
//   inviteSend   IdentityDirectory.invite (POST /api/organization-invitations): fails when another
//                invitation of the email is pending, which leaves the token
//   revoke       IdentityDirectory.revokeInvitation
//   removeCheck  `remove`: listMembers, refusing the last Admin (and, with #469, the founder)
//   removeDo     IdentityDirectory.removeMember (with #469 deleting the user)
// Invitee (Logto's sign-in, then application: single-sign-on.ts, invitation-acceptance.ts):
//   follow       a tab opens the link: Logto checks the one-time token (unused, unexpired), creates
//                the account if there is none, marks the token used and signs them in
//   signIn       a tab signs in with the account's password (the sign-in page)
//   callbackList the callback: a member is admitted; anyone else's acceptance lists the pending
//                invitations and finds one of their email whose expiresAt is still ahead
//   callbackAccept IdentityDirectory.acceptInvitation (PUT .../status Accepted); refused by Logto,
//                it throws and the sign-in fails
//   tick         time passes
//
// Left out: the registration of a new account (`registration.settle`, modelled in
// specs/registration); `organizationsOf` and Admins of other Families (one Family here); state,
// nonce and PKCE of a sign-in (each tab completes its own or fails, which grants nothing); the
// session after the callback; the mail itself; removing an Admin taking effect only at their next
// sign-in (membership changes at once here, which only makes removal stronger).
module invitation {

  // ---- Parameters -----------------------------------------------------------------------------

  /** The first Admin, made by registration. */
  const FIRST: str
  /** Emails an Admin may invite. */
  const INVITEES: Set[str]
  /** Sign-ins under way at once: tabs, devices. */
  const TABS: Set[int]
  /** How long an invitation and its token stay valid, in ticks. */
  const LIFETIME: int
  /** The last tick the model reaches. */
  const MAX_TIME: int
  /** Invitations the model creates at most. */
  const MAX_INVITATIONS: int
  /**
   * Whether accepting in the Identity Provider checks the invitation's status and expiry in its
   * transaction, as Logto does. False: only the core's own check at callbackList stands.
   */
  const IDP_CHECKS: bool
  /**
   * Whether the token's sign-in adds the user to the organization (Logto's `jitOrganizationIds`),
   * without a role; ADR-0011 rejects it. False is the design.
   */
  const JIT: bool
  /**
   * #469 (supplied mode): the founder, who registered the Family, is never removed, and removing
   * another Admin deletes their user. False is the code as it is, and fixed mode after #469.
   */
  const FOUNDER_STAYS: bool

  // ---- Types ----------------------------------------------------------------------------------

  type Status = Pending | Accepted | Revoked
  type Invitation = { email: str, status: Status, expiresAt: int }
  type Token = { email: str, expiresAt: int, used: bool }
  type SignIn =
    | Idle
    | SignedIn(str)                         // at the callback, with the verified email
    | Found({ email: str, invitation: int }) // the acceptance found this invitation
    | Admitted(str)
    | Refused(str)

  // ---- State ----------------------------------------------------------------------------------

  /** The organization's invitations, by id (Logto). */
  var invitations: int -> Invitation
  /** One-time tokens, by id (Logto). */
  var tokens: int -> Token
  /** Emails with an account in the Identity Provider. */
  var accounts: Set[str]
  /** Members of the Family's organization, and those holding its role `admin`. */
  var members: Set[str]
  var admins: Set[str]
  /** Admins page requests between their check and their write. */
  var inviting: Set[{ email: str, token: int }]
  var removing: Set[str]
  /** The sign-in of each tab. */
  var signIns: int -> SignIn
  var now: int
  /** Ghost: each acceptance, with whether its invitation was pending and unexpired then. */
  var acceptances: Set[{ invitation: int, valid: bool }]
  /** Ghost: invitations ever revoked. */
  var revoked: Set[int]

  // ---- Functional layer -----------------------------------------------------------------------

  /** Logto's status at read: a pending invitation past its expiry reads as Expired. */
  pure def isPending(i: Invitation, t: int): bool = i.status == Pending and t < i.expiresAt

  pure def pendingOf(invs: int -> Invitation, email: str, t: int): Set[int] =
    invs.keys().filter(id => invs.get(id).email == email and isPending(invs.get(id), t))

  pure def validTokensOf(ts: int -> Token, email: str, t: int): Set[int] =
    ts.keys().filter(id => ts.get(id).email == email and not(ts.get(id).used) and t < ts.get(id).expiresAt)

  /** What Logto's accept refuses: with IDP_CHECKS an invitation not pending or expired. */
  pure def acceptRefused(i: Invitation, t: int, checks: bool): bool = checks and not(isPending(i, t))

  // ---- Actions: Admins page -------------------------------------------------------------------

  action inviteCheck(email: str): bool = all {
    admins.size() > 0,
    tokens.keys().size() < MAX_INVITATIONS,
    not(members.contains(email)),
    pendingOf(invitations, email, now) == Set(),
    val token = tokens.keys().size()
    all {
      tokens' = tokens.put(token, { email: email, expiresAt: now + LIFETIME, used: false }),
      inviting' = inviting.union(Set({ email: email, token: token })),
    },
    invitations' = invitations, accounts' = accounts, members' = members, admins' = admins,
    removing' = removing, signIns' = signIns, now' = now, acceptances' = acceptances, revoked' = revoked,
  }

  action inviteSend(req: { email: str, token: int }): bool = all {
    inviting.contains(req),
    inviting' = inviting.exclude(Set(req)),
    if (pendingOf(invitations, req.email, now) == Set())
      invitations' = invitations.put(invitations.keys().size(),
        { email: req.email, status: Pending, expiresAt: tokens.get(req.token).expiresAt })
    else invitations' = invitations,
    tokens' = tokens, accounts' = accounts, members' = members, admins' = admins,
    removing' = removing, signIns' = signIns, now' = now, acceptances' = acceptances, revoked' = revoked,
  }

  action revoke(id: int): bool = all {
    admins.size() > 0,
    isPending(invitations.get(id), now),
    invitations' = invitations.set(id, { ...invitations.get(id), status: Revoked }),
    revoked' = revoked.union(Set(id)),
    tokens' = tokens, accounts' = accounts, members' = members, admins' = admins, inviting' = inviting,
    removing' = removing, signIns' = signIns, now' = now, acceptances' = acceptances,
  }

  action removeCheck(target: str): bool = all {
    members.contains(target),
    members.size() > 1,
    not(FOUNDER_STAYS and target == FIRST),
    not(removing.contains(target)),
    removing' = removing.union(Set(target)),
    invitations' = invitations, tokens' = tokens, accounts' = accounts, members' = members, admins' = admins,
    inviting' = inviting, signIns' = signIns, now' = now, acceptances' = acceptances, revoked' = revoked,
  }

  action removeDo(target: str): bool = all {
    removing.contains(target),
    removing' = removing.exclude(Set(target)),
    members' = members.exclude(Set(target)),
    admins' = admins.exclude(Set(target)),
    accounts' = if (FOUNDER_STAYS) accounts.exclude(Set(target)) else accounts,
    invitations' = invitations, tokens' = tokens,
    inviting' = inviting, signIns' = signIns, now' = now, acceptances' = acceptances, revoked' = revoked,
  }

  // ---- Actions: invitee -----------------------------------------------------------------------

  action follow(tab: int, token: int): bool = {
    val t = tokens.get(token)
    all {
      signIns.get(tab) == Idle,
      validTokensOf(tokens, t.email, now).contains(token),
      tokens' = tokens.set(token, { ...t, used: true }),
      accounts' = accounts.union(Set(t.email)),
      members' = if (JIT) members.union(Set(t.email)) else members,
      signIns' = signIns.set(tab, SignedIn(t.email)),
      invitations' = invitations, admins' = admins, inviting' = inviting, removing' = removing,
      now' = now, acceptances' = acceptances, revoked' = revoked,
    }
  }

  action signIn(tab: int, email: str): bool = all {
    signIns.get(tab) == Idle,
    accounts.contains(email),
    signIns' = signIns.set(tab, SignedIn(email)),
    invitations' = invitations, tokens' = tokens, accounts' = accounts, members' = members, admins' = admins,
    inviting' = inviting, removing' = removing, now' = now, acceptances' = acceptances, revoked' = revoked,
  }

  /** The callback of a signed-in tab: a member is admitted; anyone else looks up their invitation. */
  pure def afterLookup(s: SignIn, ms: Set[str], invs: int -> Invitation, t: int): SignIn =
    match s {
      | SignedIn(email) =>
        if (ms.contains(email)) Admitted(email)
        // listInvitations (Pending at read) and the core's own `expiresAt > now`; at most one is pending
        else if (pendingOf(invs, email, t) == Set()) Refused(email)
        else Found({ email: email, invitation: pendingOf(invs, email, t).fold(-1, (_, id) => id) })
      | _ => s
    }

  pure def isSignedIn(s: SignIn): bool = match s { | SignedIn(_) => true | _ => false }
  pure def isFound(s: SignIn): bool = match s { | Found(_) => true | _ => false }
  pure def isDone(s: SignIn): bool = match s { | Admitted(_) => true | Refused(_) => true | _ => false }
  /** The lookup of a `Found` sign-in. */
  pure def foundOf(s: SignIn): { email: str, invitation: int } =
    match s { | Found(f) => f | _ => { email: "", invitation: -1 } }

  action callbackList(tab: int): bool = all {
    isSignedIn(signIns.get(tab)),
    signIns' = signIns.set(tab, afterLookup(signIns.get(tab), members, invitations, now)),
    invitations' = invitations, tokens' = tokens, accounts' = accounts, members' = members, admins' = admins,
    inviting' = inviting, removing' = removing, now' = now, acceptances' = acceptances, revoked' = revoked,
  }

  action callbackAccept(tab: int): bool = all {
    isFound(signIns.get(tab)),
    val f = foundOf(signIns.get(tab))
    val i = invitations.get(f.invitation)
    if (acceptRefused(i, now, IDP_CHECKS)) all {
      // Logto answers 422, acceptInvitation throws, the sign-in fails
      signIns' = signIns.set(tab, Refused(f.email)),
      invitations' = invitations, members' = members, admins' = admins, acceptances' = acceptances,
    } else all {
      signIns' = signIns.set(tab, Admitted(f.email)),
      invitations' = invitations.set(f.invitation, { ...i, status: Accepted }),
      members' = members.union(Set(f.email)),
      admins' = admins.union(Set(f.email)),
      acceptances' = acceptances.union(Set({ invitation: f.invitation, valid: isPending(i, now) })),
    },
    tokens' = tokens, accounts' = accounts, inviting' = inviting, removing' = removing, now' = now, revoked' = revoked,
  }

  /** A finished sign-in ends; the tab may sign in again. */
  action leave(tab: int): bool = all {
    isDone(signIns.get(tab)),
    signIns' = signIns.set(tab, Idle),
    invitations' = invitations, tokens' = tokens, accounts' = accounts, members' = members, admins' = admins,
    inviting' = inviting, removing' = removing, now' = now, acceptances' = acceptances, revoked' = revoked,
  }

  action tick: bool = all {
    now < MAX_TIME,
    now' = now + 1,
    invitations' = invitations, tokens' = tokens, accounts' = accounts, members' = members, admins' = admins,
    inviting' = inviting, removing' = removing, signIns' = signIns, acceptances' = acceptances, revoked' = revoked,
  }

  action init: bool = all {
    invitations' = Map(),
    tokens' = Map(),
    accounts' = Set(FIRST),
    members' = Set(FIRST),
    admins' = Set(FIRST),
    inviting' = Set(),
    removing' = Set(),
    signIns' = TABS.mapBy(_ => Idle),
    now' = 0,
    acceptances' = Set(),
    revoked' = Set(),
  }

  action step: bool = any {
    nondet email = INVITEES.oneOf()
    inviteCheck(email),
    all { inviting != Set(), nondet req = inviting.oneOf() inviteSend(req) },
    all { invitations.keys() != Set(), nondet id = invitations.keys().oneOf() revoke(id) },
    all { members != Set(), nondet target = members.oneOf() removeCheck(target) },
    all { removing != Set(), nondet target = removing.oneOf() removeDo(target) },
    nondet tab = TABS.oneOf()
    any {
      all { tokens.keys() != Set(), nondet token = tokens.keys().oneOf() follow(tab, token) },
      all { accounts != Set(), nondet email = accounts.oneOf() signIn(tab, email) },
      callbackList(tab),
      callbackAccept(tab),
      leave(tab),
    },
    tick,
  }

  // ---- Properties -----------------------------------------------------------------------------

  /** An Admin is made only from an invitation that was pending and unexpired at that moment. */
  val acceptedOnlyValid: bool = acceptances.forall(a => a.valid)

  /** No invitation is accepted after it was revoked. */
  val noAcceptanceAfterRevocation: bool = acceptances.forall(a => not(revoked.contains(a.invitation)))

  /** The token grants nothing in the Family: every member but the first came in by an accepted invitation. */
  val tokenGrantsNothing: bool =
    members.forall(e => e == FIRST or acceptances.exists(a => invitations.get(a.invitation).email == e))

  /** Every member holds the role `admin`, and only members do. */
  val membersAreAdmins: bool = members == admins

  /**
   * A valid invitation stays followable: while it is pending and its invitee no member, they hold a
   * valid token or already have an account to sign in with, and the callback will find it.
   */
  val invitationFollowable: bool = invitations.keys().forall(id => {
    val i = invitations.get(id)
    (isPending(i, now) and not(members.contains(i.email)))
      implies (accounts.contains(i.email) or validTokensOf(tokens, i.email, now) != Set())
  })

  /**
   * The Family keeps an Admin. `remove` refuses the last one, but two Admins removing each other at
   * once both see two; only the founder staying (#469) rules it out.
   */
  val someAdmin: bool = admins != Set()

  // ---- Witnesses ------------------------------------------------------------------------------

  val accepted: bool = acceptances != Set()
  val invitedTwice: bool = invitations.keys().size() >= 2
  val revokedOne: bool = revoked != Set()
  /** A sign-in found an invitation that was gone by the time it accepted. */
  val refusedByIdp: bool = TABS.exists(t => signIns.get(t) == Refused(FIRST)) or
    (revoked != Set() and TABS.exists(t => isDone(signIns.get(t)) and not(members.contains(foundOf(signIns.get(t)).email))))
  /** Two tabs at the callback for one email. */
  val twoTabs: bool = TABS.exists(a => TABS.exists(b => a != b and signIns.get(a) != Idle and signIns.get(a) == signIns.get(b)))
  /** A revoked invitee still created an account with their token: an account, but no Admin. */
  val strayAccount: bool = accounts.exists(e => e != FIRST and not(members.contains(e)) and
    invitations.keys().forall(id => invitations.get(id).email != e or invitations.get(id).status == Revoked) and
    invitations.keys().exists(id => invitations.get(id).email == e))
  val removedOne: bool = INVITEES.exists(e => acceptances.exists(a => invitations.get(a.invitation).email == e) and not(members.contains(e)))
  val expiredUnused: bool = invitations.keys().exists(id => invitations.get(id).status == Pending and now >= invitations.get(id).expiresAt)
}
