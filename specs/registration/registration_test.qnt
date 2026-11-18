// Scenarios of preparing and registration, and the instances of their model that `check.sh` checks (registration.qnt).
module scenarios {
  import registration.* from "./registration"
  export registration.*

  /** Core `c` prepares the database from start to end. */
  action prepares(c: str): bool = lock(c).then(check(c)).then(draw(c)).then(commit(c))

  /** `u` registers and one delivery of the event runs through on handler 1, in fixed mode. */
  action registersFixed(u: str): bool =
    signUp(u).then(receive(1, u)).then(create(1)).then(addMember(1)).then(record(1)).then(close(1))

  /** The platform takes `u`'s pending delivery. */
  action deliverOf(u: str): bool = {
    nondet d = deliveries.filter(d => d.user == u).oneOf()
    deliver(d)
  }

  /** Two cores start at once: the second migrates nothing and serves the id the first drew. */
  run twoCoresOneId =
    init.then(prepares("api")).then(lock("worker")).then(check("worker")).then(commit("worker"))
      .expect(allUp and oneFamilyId and safety)

  /** A core dying mid-migration leaves nothing; started again, it prepares the Family. */
  run crashLeavesNothing =
    init.then(lock("api")).then(check("api")).then(draw("api")).then(crashCore("api"))
      .expect(db.familyId == 0 and not(db.migrated))
      .then(prepares("api")).expect(coreUp and safety)

  /** The first registration creates the Family with its Admin and closes registration. */
  run firstRegistrationCreatesFamily =
    init.then(prepares("api")).then(registersFixed("u1"))
      .expect(familyWithAdmin and registrationClosed and pending == Set() and safety)

  /** A delivery that comes again, after the 204 was lost, is ignored. */
  run redeliveryIsIgnored =
    init.then(prepares("api")).then(signUp("u1")).then(receive(1, "u1")).then(receive(2, "u1"))
      .then(create(1)).then(addMember(1)).then(record(1)).then(close(1))
      .expect(orgs.keys().size() == 1 and safety)

  /** Two registrations at once: the loser's member is removed, and only the first is an Admin. */
  run twoRegistrationsAtOnce =
    init.then(prepares("api")).then(signUp("u1")).then(signUp("u2"))
      .then(receive(1, "u1")).then(receive(2, "u2"))
      .then(create(1)).then(create(2)).then(addMember(1)).then(addMember(2))
      .then(record(1)).then(record(2)).then(remove(2)).then(close(1)).then(close(2))
      .expect(onlyFamilyOrgHasAdmins and oneOrganizationPerEvent)

  /** A registration slipping through after the Family exists creates nothing. */
  run lateRegistrationCreatesNothing =
    init.then(prepares("api")).then(signUp("u2")).then(registersFixed("u1"))
      .then(receive(1, "u2")).then(close(1))
      .expect(orgs.keys().size() == 1 and pending == Set() and safety)

  /**
   * A call that fails after the organization was created: the event is forgotten, delivered again,
   * and creates a second organization, while the first keeps the user as a member.
   */
  run failAfterCreate =
    init.then(prepares("api")).then(signUp("u1")).then(receive(1, "u1")).then(create(1)).then(addMember(1))
      .then(throws(1)).then(receive(1, "u1")).then(create(1))

  /** A core dying mid-registration: the event stays processed, so its deliveries are ignored and no Family comes. */
  run crashMidRegistration =
    init.then(prepares("api")).then(signUp("u1")).then(receive(1, "u1")).then(crash(1))
      .then(receive(1, "u1"))
}

/** Fixed mode as the code is: FAMILY_ID given to both cores, written in the migrations' transaction. */
module fixed {
  import scenarios(CORES = Set("api", "worker"), GIVEN = Map("api" -> 1, "worker" -> 1), USERS = Set("u1", "u2"), HANDLERS = Set(1, 2),
    SUPPLIED = false, ID_IN_MIGRATION = true, MAX_ORGS = 3, MAX_DRAWS = 3).*

  run twoCoresOneIdTest = twoCoresOneId.expect(db.familyId == 1)
  run crashLeavesNothingTest = crashLeavesNothing
  run firstRegistrationCreatesFamilyTest = firstRegistrationCreatesFamily
  run redeliveryIsIgnoredTest = redeliveryIsIgnored
  run twoRegistrationsAtOnceTest = twoRegistrationsAtOnce
  run lateRegistrationCreatesNothingTest = lateRegistrationCreatesNothing
  run failAfterCreateTest = failAfterCreate.expect(not(oneOrganizationPerEvent))
  run crashMidRegistrationTest = crashMidRegistration.expect(pending == Set() and not(eventCanFinish))
}

/** Fixed mode without FAMILY_ID: the Family keeps the id the first core drew. */
module drawn {
  import scenarios(CORES = Set("api", "worker"), GIVEN = Map("api" -> 0, "worker" -> 0), USERS = Set("u1", "u2"), HANDLERS = Set(1, 2),
    SUPPLIED = false, ID_IN_MIGRATION = true, MAX_ORGS = 3, MAX_DRAWS = 3).*

  run twoCoresOneIdTest = twoCoresOneId.expect(db.familyId == randomId(1))
}

/** Before the amendment: the given id written once the migrations committed. */
module unfixedId {
  import scenarios(CORES = Set("api", "worker"), GIVEN = Map("api" -> 1, "worker" -> 1), USERS = Set("u1"), HANDLERS = Set(1),
    SUPPLIED = false, ID_IN_MIGRATION = false, MAX_ORGS = 2, MAX_DRAWS = 3).*

  /** The core dies between the commit and the write: the random id stays, and no core starts again. */
  run strayRandomIdTest =
    init.then(lock("api")).then(check("api")).then(draw("api")).then(commit("api")).then(crashCore("api"))
      .expect(not(noStrayRandomId) and not(coreCanStart))
}

/** Supplied mode as the code is. */
module supplied {
  import scenarios(CORES = Set("api"), GIVEN = Map("api" -> 0), USERS = Set("u1", "u2"), HANDLERS = Set(1, 2),
    SUPPLIED = true, ID_IN_MIGRATION = true, MAX_ORGS = 3, MAX_DRAWS = 4).*

  run everyRegistrationCreatesAFamilyTest =
    init.then(signUp("u1")).then(signUp("u2"))
      .then(receive(1, "u1")).then(create(1)).then(addMember(1)).then(send(1))
      .then(receive(1, "u2")).then(create(1)).then(addMember(1)).then(send(1))
      .then(deliverOf("u1")).then(deliverOf("u2"))
      .expect(families.size() == 2 and safety and progress)

  /** Failing after the organization: the retry draws another Family id and organization. */
  run failAfterCreateTest =
    init.then(signUp("u1")).then(receive(1, "u1")).then(create(1)).then(addMember(1)).then(throws(1))
      .then(receive(1, "u1")).then(create(1)).then(addMember(1)).then(send(1))
      .expect(not(oneOrganizationPerEvent))

  run crashMidRegistrationTest =
    init.then(signUp("u1")).then(receive(1, "u1")).then(create(1)).then(crash(1)).then(receive(1, "u1"))
      .expect(pending == Set() and not(eventCanFinish))
}
