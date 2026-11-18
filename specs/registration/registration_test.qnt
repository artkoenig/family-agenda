// Scenarios of preparing and registration, and the instances of their model that `check.sh` checks (registration.qnt).
module scenarios {
  import registration.* from "./registration"
  export registration.*

  /** Core `c` prepares the database from start to end. */
  action prepares(c: str): bool = lock(c).then(check(c)).then(draw(c)).then(commit(c))

  /** `u` registers and the event runs through on handler 1, in fixed mode. */
  action registersFixed(u: str): bool =
    signUp(u).then(receive(1, u)).then(create(1)).then(addMember(1)).then(record(1)).then(close(1))

  /** `u`'s delivered event runs through on handler 1, in supplied mode. */
  action handledSupplied(u: str): bool = receive(1, u).then(create(1)).then(addMember(1)).then(send(1))

  /** The platform takes `u`'s pending delivery. */
  action deliverOf(u: str): bool = {
    nondet d = platform.deliveries.filter(d => d.user == u).oneOf()
    deliver(d)
  }

  // ---- Preparing ----

  /** Two cores start at once: the second migrates nothing and serves the id the first drew. */
  run twoCoresOneId =
    init.then(prepares("api")).then(lock("worker")).then(check("worker")).then(commit("worker"))
      .expect(allUp and oneFamilyId and safety)

  /** A core dying mid-migration leaves nothing; started again, it prepares the Family. */
  run crashLeavesNothing =
    init.then(lock("api")).then(check("api")).then(draw("api")).then(crashCore("api"))
      .expect(db.familyId == 0 and not(db.migrated))
      .then(prepares("api")).expect(coreUp and safety)

  // ---- Fixed mode ----

  /** The first registration creates the Family with its Admin and closes registration. */
  run firstRegistrationCreatesFamily =
    init.then(prepares("api")).then(registersFixed("u1"))
      .expect(familyWithAdmin and registrationClosed and safety and progress)

  /** The event delivered twice, to two replicas at once: the second is ignored. */
  run duplicateIsIgnored =
    init.then(prepares("api")).then(signUp("u1")).then(duplicate("u1")).then(receive(1, "u1")).then(receive(2, "u1"))
      .then(create(1)).then(addMember(1)).then(record(1)).then(close(1))
      .expect(idp.orgs.keys().size() == 1 and safety and progress)

  /** Two registrations at once: the loser's member is removed, and only the first is an Admin. */
  run twoRegistrationsAtOnce =
    init.then(prepares("api")).then(signUp("u1")).then(signUp("u2"))
      .then(receive(1, "u1")).then(receive(2, "u2"))
      .then(create(1)).then(create(2)).then(addMember(1)).then(addMember(2))
      .then(record(1)).then(record(2)).then(remove(2)).then(close(1)).then(close(2))

  /** A registration slipping through after the Family exists creates nothing. */
  run lateRegistrationCreatesNothing =
    init.then(prepares("api")).then(signUp("u2")).then(registersFixed("u1"))
      .then(receive(1, "u2")).then(close(1))
      .expect(idp.orgs.keys().size() == 1 and safety and progress)

  /** A call failing after the organization was created: the user stays its member, and no Family comes. */
  run fixedThrowAfterAddMember =
    init.then(prepares("api")).then(signUp("u1")).then(receive(1, "u1")).then(create(1)).then(addMember(1)).then(throws(1))

  /** A core dying mid-registration: the event is never delivered again, and no Family comes. */
  run fixedCrashMidRegistration =
    init.then(prepares("api")).then(signUp("u1")).then(receive(1, "u1")).then(crash(1))

  // ---- Supplied mode ----

  /** Every registration creates a Family of its own. */
  run everyRegistrationCreatesAFamily =
    init.then(signUp("u1")).then(signUp("u2")).then(handledSupplied("u1")).then(handledSupplied("u2"))
      .then(deliverOf("u1")).then(deliverOf("u2"))
      .expect(platform.families.size() == 2 and safety and progress)

  /** #467: a user who became an Admin by invitation before their `PostRegister` arrived. */
  run memberBeforePostRegister =
    init.then(signUp("u1")).then(handledSupplied("u1")).then(signUp("u2")).then(invite("u2", 1))
      .then(handledSupplied("u2"))

  /** #467: a user deleted right after sign-up; addMember throws and leaves the organization empty. */
  run deletedBeforePostRegister =
    init.then(signUp("u1")).then(deleteUser("u1")).then(receive(1, "u1")).then(create(1)).then(throws(1))

  /** #467: the central sign-in reruns a `PostRegister` that was handled slowly: it is ignored. */
  run slowPostRegisterRepair =
    init.then(signUp("u1")).then(receive(1, "u1")).then(create(1)).then(signIn("u1")).then(receive(2, "u1"))
      .then(addMember(1)).then(send(1)).then(deliverOf("u1"))
      .expect(idp.orgs.keys().size() == 1 and familyWithAdmin and safety and progress)

  /** A call failing after createOrganization: the central sign-in reruns `PostRegister`, which creates a second one. */
  run suppliedThrowAfterCreate =
    init.then(signUp("u1")).then(receive(1, "u1")).then(create(1)).then(throws(1))
      .then(signIn("u1")).then(handledSupplied("u1"))

  /** A call failing after addMember: the user is a member, so the central sign-in never reruns it. */
  run suppliedThrowAfterAddMember =
    init.then(signUp("u1")).then(receive(1, "u1")).then(create(1)).then(addMember(1)).then(throws(1))

  /** A core dying after recordIfNew: the central sign-in reruns `PostRegister`, which is ignored. */
  run suppliedCrashMidRegistration =
    init.then(signUp("u1")).then(receive(1, "u1")).then(crash(1)).then(signIn("u1")).then(receive(1, "u1"))
}

/** Fixed mode as the code is: FAMILY_ID given to both cores, written in the migrations' transaction. */
module fixed {
  import scenarios(CORES = Set("api", "worker"), GIVEN = Map("api" -> 1, "worker" -> 1), USERS = Set("u1", "u2"), HANDLERS = Set(1, 2),
    SUPPLIED = false, ID_IN_MIGRATION = true, ACCOUNT_CHECKS = false, MAX_ORGS = 3, MAX_DRAWS = 3, MAX_EVENTS = 4).*

  run twoCoresOneIdTest = twoCoresOneId.expect(db.familyId == 1)
  run crashLeavesNothingTest = crashLeavesNothing
  run firstRegistrationCreatesFamilyTest = firstRegistrationCreatesFamily
  run duplicateIsIgnoredTest = duplicateIsIgnored
  run lateRegistrationCreatesNothingTest = lateRegistrationCreatesNothing
  /** The loser's organization stays, empty. */
  run twoRegistrationsAtOnceTest = twoRegistrationsAtOnce
    .expect(onlyFamilyOrgHasAdmins and not(onlyFirstCreates) and not(noEmptyOrganization))
  run fixedThrowAfterAddMemberTest = fixedThrowAfterAddMember.expect(not(onlyFamilyOrgHasAdmins) and not(eventCanFinish))
  run fixedCrashMidRegistrationTest = fixedCrashMidRegistration.expect(not(eventCanFinish))
}

/** Fixed mode without FAMILY_ID: the Family keeps the id the first core drew. */
module drawn {
  import scenarios(CORES = Set("api", "worker"), GIVEN = Map("api" -> 0, "worker" -> 0), USERS = Set("u1", "u2"), HANDLERS = Set(1, 2),
    SUPPLIED = false, ID_IN_MIGRATION = true, ACCOUNT_CHECKS = false, MAX_ORGS = 3, MAX_DRAWS = 3, MAX_EVENTS = 4).*

  run twoCoresOneIdTest = twoCoresOneId.expect(db.familyId == randomId(1))
}

/** Before the amendment: the given id written once the migrations committed. */
module unfixedId {
  import scenarios(CORES = Set("api", "worker"), GIVEN = Map("api" -> 1, "worker" -> 1), USERS = Set("u1"), HANDLERS = Set(1),
    SUPPLIED = false, ID_IN_MIGRATION = false, ACCOUNT_CHECKS = false, MAX_ORGS = 2, MAX_DRAWS = 3, MAX_EVENTS = 2).*

  /** The core dies between the commit and the write: the random id stays, and no core starts again. */
  run strayRandomIdTest =
    init.then(lock("api")).then(check("api")).then(draw("api")).then(commit("api")).then(crashCore("api"))
      .expect(not(noStrayRandomId) and not(coreCanStart))
}

/** Supplied mode as the code is, without #467's checks. */
module supplied {
  import scenarios(CORES = Set("api"), GIVEN = Map("api" -> 0), USERS = Set("u1", "u2"), HANDLERS = Set(1, 2),
    SUPPLIED = true, ID_IN_MIGRATION = true, ACCOUNT_CHECKS = false, MAX_ORGS = 3, MAX_DRAWS = 4, MAX_EVENTS = 4).*

  run everyRegistrationCreatesAFamilyTest = everyRegistrationCreatesAFamily
  run slowPostRegisterRepairTest = slowPostRegisterRepair
  /** #467's findings: a second Family for an Admin, an empty organization left behind. */
  run memberBeforePostRegisterTest = memberBeforePostRegister.expect(not(oneFamilyPerAdmin))
  run deletedBeforePostRegisterTest = deletedBeforePostRegister.expect(not(noEmptyOrganization))
  run suppliedThrowAfterCreateTest = suppliedThrowAfterCreate.expect(not(oneOrganizationPerEvent) and not(noEmptyOrganization))
  run suppliedThrowAfterAddMemberTest = suppliedThrowAfterAddMember.expect(not(eventCanFinish))
  run suppliedCrashMidRegistrationTest = suppliedCrashMidRegistration.expect(not(eventCanFinish))
}

/** Supplied mode with #467's checks: they fix #467's findings, not the ones of a throw or a crash. */
module suppliedChecked {
  import scenarios(CORES = Set("api"), GIVEN = Map("api" -> 0), USERS = Set("u1", "u2"), HANDLERS = Set(1, 2),
    SUPPLIED = true, ID_IN_MIGRATION = true, ACCOUNT_CHECKS = true, MAX_ORGS = 3, MAX_DRAWS = 4, MAX_EVENTS = 4).*

  run everyRegistrationCreatesAFamilyTest = everyRegistrationCreatesAFamily
  run slowPostRegisterRepairTest = slowPostRegisterRepair
  /** The invited Admin's `PostRegister` creates nothing. */
  run memberBeforePostRegisterTest =
    init.then(signUp("u1")).then(handledSupplied("u1")).then(signUp("u2")).then(invite("u2", 1)).then(receive(1, "u2"))
      .expect(idp.orgs.keys().size() == 1 and safety and progress)
  /** The deleted user's `PostRegister` creates nothing. */
  run deletedBeforePostRegisterTest =
    init.then(signUp("u1")).then(deleteUser("u1")).then(receive(1, "u1"))
      .expect(idp.orgs.keys().size() == 0 and safety and progress)
  run suppliedThrowAfterCreateTest = suppliedThrowAfterCreate.expect(not(oneOrganizationPerEvent) and not(noEmptyOrganization))
  run suppliedThrowAfterAddMemberTest = suppliedThrowAfterAddMember.expect(not(eventCanFinish))
  run suppliedCrashMidRegistrationTest = suppliedCrashMidRegistration.expect(not(eventCanFinish))
}
