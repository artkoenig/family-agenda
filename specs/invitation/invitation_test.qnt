// Scenarios of inviting an Admin, and the instances of their model that `check.sh` checks (invitation.qnt).
module scenarios {
  import invitation.* from "./invitation"
  export invitation.*

  val safety: bool = acceptedOnlyValid and noAcceptanceAfterRevocation and tokenGrantsNothing and membersAreAdmins

  /** The first Admin invites `e`, and the invitation is sent with token 0's link. */
  action invites(e: str): bool = inviteCheck(e).then(inviteSend({ email: e, token: tokens.keys().size() - 1 }))

  /** Tab `t` follows token `k`'s link and goes through the callback. */
  action follows(t: int, k: int): bool = follow(t, k).then(callbackList(t)).then(callbackAccept(t))

  /** An invitee follows the link and becomes an Admin. */
  run followedIsAccepted =
    init.then(invites("bea")).then(follows(1, 0))
      .expect(members.contains("bea") and admins.contains("bea") and safety)

  /** The link opened in two tabs: the token works once; the second tab signs in and is admitted as a member. */
  run secondTab =
    init.then(invites("bea")).then(follows(1, 0))
      .then(signIn(2, "bea")).then(callbackList(2))
      .expect(signIns.get(2) == Admitted("bea") and safety)

  /** Both tabs reach the callback before either accepts: Logto accepts once and refuses the second. */
  run twoTabsAtOnce =
    init.then(invites("bea")).then(follow(1, 0)).then(signIn(2, "bea"))
      .then(callbackList(1)).then(callbackList(2)).then(callbackAccept(1)).then(callbackAccept(2))
      .expect(members.contains("bea") and acceptances.size() == 1 and safety)

  /** Revoked between the callback's lookup and its acceptance: Logto refuses, no Admin is made. */
  run revokedMidway =
    init.then(invites("bea")).then(follow(1, 0)).then(callbackList(1)).then(revoke(0)).then(callbackAccept(1))
      .expect(not(members.contains("bea")) and signIns.get(1) == Refused("bea") and safety)

  /** Expired between lookup and acceptance: refused too. */
  run expiredMidway =
    init.then(invites("bea")).then(follow(1, 0)).then(callbackList(1))
      .then(tick).then(tick).then(tick).then(callbackAccept(1))
      .expect(not(members.contains("bea")) and safety)

  /** A revoked invitee's token still creates an account, which grants nothing. */
  run revokedTokenGrantsNothing =
    init.then(invites("bea")).then(revoke(0)).then(follows(1, 0))
      .fail()

  run revokedTokenOnlyAnAccount =
    init.then(invites("bea")).then(revoke(0)).then(follow(1, 0)).then(callbackList(1))
      .expect(accounts.contains("bea") and not(members.contains("bea")) and signIns.get(1) == Refused("bea"))

  /** Invited again after a revocation, the old account signs in and accepts the new invitation. */
  run reinvited =
    init.then(invites("bea")).then(revoke(0)).then(follow(1, 0)).then(callbackList(1)).then(leave(1))
      .then(invites("bea")).then(signIn(1, "bea")).then(callbackList(1)).then(callbackAccept(1))
      .expect(members.contains("bea") and safety)

  /** Token used but the callback failed: the invitee signs in with their password and is accepted. */
  run passwordAfterFailedCallback =
    init.then(invites("bea")).then(follow(1, 0)).then(signIn(2, "bea")).then(callbackList(2)).then(callbackAccept(2))
      .expect(members.contains("bea"))

  /** Two Admins invite the same email at once: Logto keeps one pending invitation; the other token is left over. */
  run invitedTwiceAtOnce =
    init.then(inviteCheck("bea")).then(inviteCheck("bea"))
      .then(inviteSend({ email: "bea", token: 0 })).then(inviteSend({ email: "bea", token: 1 }))
      .expect(invitations.keys().size() == 1 and tokens.keys().size() == 2)

  /** The JIT counterexample: the token's sign-in makes a member without the role, who is never accepted. */
  run jitMemberWithoutRole =
    init.then(invites("bea")).then(follow(1, 0)).then(callbackList(1))
      .expect(members.contains("bea") and not(admins.contains("bea")) and signIns.get(1) == Admitted("bea"))

  /** The unchecked counterexample: the core's own check alone accepts after a revocation. */
  run uncheckedAcceptsRevoked =
    init.then(invites("bea")).then(follow(1, 0)).then(callbackList(1)).then(revoke(0)).then(callbackAccept(1))
      .expect(members.contains("bea") and not(noAcceptanceAfterRevocation))

  /** Removed with #469, the user is deleted; invited again, they come back with a new account. */
  run removedAndReinvited =
    init.then(invites("bea")).then(follows(1, 0)).then(leave(1)).then(removeCheck("bea")).then(removeDo("bea"))
      .expect(not(accounts.contains("bea")))
      .then(invites("bea")).then(follows(1, 1))
      .expect(members.contains("bea") and safety)

  /** With #469 the founder cannot be removed. */
  run founderStays =
    init.then(invites("bea")).then(follows(1, 0)).then(removeCheck("ada")).fail()

  /** Two Admins remove each other at once: both see two Admins, and none is left. */
  run removedEachOther =
    init.then(invites("bea")).then(follows(1, 0))
      .then(removeCheck("ada")).then(removeCheck("bea")).then(removeDo("ada")).then(removeDo("bea"))
      .expect(not(someAdmin))
}

/** The design, as the code and Logto are: two invitees, three tabs. */
module design {
  import scenarios(FIRST = "ada", INVITEES = Set("bea", "cy"), TABS = Set(1, 2, 3), LIFETIME = 3, MAX_TIME = 8,
    MAX_INVITATIONS = 4, IDP_CHECKS = true, JIT = false, FOUNDER_STAYS = false).*

  run followedIsAcceptedTest = followedIsAccepted
  run secondTabTest = secondTab
  run twoTabsAtOnceTest = twoTabsAtOnce
  run revokedMidwayTest = revokedMidway
  run expiredMidwayTest = expiredMidway
  run revokedTokenGrantsNothingTest = revokedTokenGrantsNothing
  run revokedTokenOnlyAnAccountTest = revokedTokenOnlyAnAccount
  run reinvitedTest = reinvited
  run passwordAfterFailedCallbackTest = passwordAfterFailedCallback
  run invitedTwiceAtOnceTest = invitedTwiceAtOnce
  run removedEachOtherTest = removedEachOther
}

/** The design with #469 (supplied mode): the founder stays, a removed Admin's user is deleted. */
module founder {
  import scenarios(FIRST = "ada", INVITEES = Set("bea", "cy"), TABS = Set(1, 2, 3), LIFETIME = 3, MAX_TIME = 8,
    MAX_INVITATIONS = 4, IDP_CHECKS = true, JIT = false, FOUNDER_STAYS = true).*

  run followedIsAcceptedTest = followedIsAccepted
  run removedAndReinvitedTest = removedAndReinvited
  run founderStaysTest = founderStays
}

/** One invitee, two tabs: small enough to check every trace. */
module small {
  import scenarios(FIRST = "ada", INVITEES = Set("bea"), TABS = Set(1, 2), LIFETIME = 2, MAX_TIME = 3,
    MAX_INVITATIONS = 2, IDP_CHECKS = true, JIT = false, FOUNDER_STAYS = false).*
}

/** Counterexample: an Identity Provider that accepts without checking the invitation. */
module unchecked {
  import scenarios(FIRST = "ada", INVITEES = Set("bea"), TABS = Set(1, 2), LIFETIME = 2, MAX_TIME = 3,
    MAX_INVITATIONS = 2, IDP_CHECKS = false, JIT = false, FOUNDER_STAYS = false).*

  run uncheckedAcceptsRevokedTest = uncheckedAcceptsRevoked
}

/** Counterexample: JIT organization membership through the token (rejected by ADR-0011). */
module jit {
  import scenarios(FIRST = "ada", INVITEES = Set("bea"), TABS = Set(1, 2), LIFETIME = 2, MAX_TIME = 3,
    MAX_INVITATIONS = 2, IDP_CHECKS = true, JIT = true, FOUNDER_STAYS = false).*

  run jitMemberWithoutRoleTest = jitMemberWithoutRole
}
