// Scenarios of a rolling update and the described migrations (migrations.qnt) as instances of its
// model (rollingUpdate.qnt), which `check.sh` checks. Those named `...Broken...` must violate safety.
module scenarios {
  import rollingUpdate.* from "./rollingUpdate"
  export rollingUpdate.*

  /** The instance's LAST names its last release. */
  run lastIsLast = assert(LAST == RELEASES.length() - 1)

  /** Rolls core 1 onto the next release: deploy, replace it, open it (it migrates). */
  action rollOne: bool = deploy.then(stop(1)).then(start(1)).then(open(1))

  /** Replaces core `id` with one of the newest release deployed, which opens the Family. */
  action replace(id: CoreId): bool = stop(id).then(start(id)).then(open(id))

  /** Rolls every core onto the next release, the old ones writing until they recheck. */
  action rollAll: bool =
    rollOne.then(write(2, "colour")).then(recheck(2)).then(replace(2)).then(replace(3))

  /**
   * The rename finishes (liveness): release by release, the old cores serve and write on the
   * migrated schema, recheck and refuse, and go; the contract follows once they are gone.
   */
  run updateFinishes =
    init.then(rollOne)
      .expect(safety and overlapOnNewSchema)
      .then(write(2, "colour")).then(write(1, "colour"))
      .then(recheck(2)).expect(staleCoreRefuses and safety)
      .then(replace(2)).then(replace(3))
      .then(rollAll).expect(safety)
      .then(rollAll).expect(safety)
      .then(rollOne).expect(contracted and safety)
      .then(replace(2)).then(replace(3))
      .expect(finished and safety and canFinish)

  /** The next release is not deployed while a core of the release before runs. */
  run noDeployWhileOldCoresRun = init.then(rollOne).then(deploy).fail()

  /** An older core does not open a database a newer release migrated (`migrated-by-newer-release`). */
  run oldCoreRefused = init.then(rollOne).then(recheck(2)).then(open(2)).fail()

  /** In the broken rename, an old core's write after the copy leaves the new core a stale value. */
  run staleAfterCopy = init.then(rollOne).then(write(2, "colour")).expect(not(noValueLost))
}

/** 0016_admin_session_id_token: expand only. */
module idToken {
  import migrations.* from "./migrations"
  import scenarios(RELEASES = idTokenReleases, LAST = 1, DATUM_OF = idTokenData, CORES = Set(1, 2, 3), MAX_WRITES = 5).* from "./rollingUpdate_test"

  run lastIsLastTest = lastIsLast
}

/** 0009_family_id as the rule asks: add and copy, a release later the drop. */
module familyId {
  import migrations.* from "./migrations"
  import scenarios(RELEASES = familyIdExpandContract, LAST = 2, DATUM_OF = familyIdData, CORES = Set(1, 2, 3), MAX_WRITES = 5).* from "./rollingUpdate_test"

  run lastIsLastTest = lastIsLast
}

/** 0009_family_id as shipped: contract before the old cores are gone; must violate safety. */
module familyIdBroken {
  import migrations.* from "./migrations"
  import scenarios(RELEASES = familyIdShipped, LAST = 1, DATUM_OF = familyIdData, CORES = Set(1, 2, 3), MAX_WRITES = 5).* from "./rollingUpdate_test"

  run lastIsLastTest = lastIsLast

  /** Opening the new core migrates in one step; the old cores' reads of `public_id` now fail. */
  run contractBeforeOldCoresGoneTest = init.then(deploy).then(stop(1)).then(start(1)).then(open(1))
    .expect(not(columnsExist) and not(contractWithoutOldCores))
}

/** A rename of a column the old code writes, in four releases. */
module colour {
  import migrations.* from "./migrations"
  import scenarios(RELEASES = colourRename, LAST = 4, DATUM_OF = colourData, CORES = Set(1, 2, 3), MAX_WRITES = 5).* from "./rollingUpdate_test"

  run lastIsLastTest = lastIsLast

  run updateFinishesTest = updateFinishes
  run noDeployWhileOldCoresRunTest = noDeployWhileOldCoresRun
  run oldCoreRefusedTest = oldCoreRefused
}

/** The same rename in two releases; must violate safety. */
module colourBroken {
  import migrations.* from "./migrations"
  import scenarios(RELEASES = colourRenameHasty, LAST = 2, DATUM_OF = colourData, CORES = Set(1, 2, 3), MAX_WRITES = 5).* from "./rollingUpdate_test"

  run lastIsLastTest = lastIsLast

  run staleAfterCopyTest = staleAfterCopy
}

/** Smaller, for Apalache: one old and one new core make every overlap. */
module colourExhaustive {
  import migrations.* from "./migrations"
  import scenarios(RELEASES = colourRename, LAST = 4, DATUM_OF = colourData, CORES = Set(1, 2), MAX_WRITES = 2).* from "./rollingUpdate_test"

  run lastIsLastTest = lastIsLast
}

/** Its broken twin, in which Apalache must find the stale read. */
module colourBrokenExhaustive {
  import migrations.* from "./migrations"
  import scenarios(RELEASES = colourRenameHasty, LAST = 2, DATUM_OF = colourData, CORES = Set(1, 2), MAX_WRITES = 2).* from "./rollingUpdate_test"

  run lastIsLastTest = lastIsLast
}

/** In which Apalache must find the missing column. */
module familyIdBrokenExhaustive {
  import migrations.* from "./migrations"
  import scenarios(RELEASES = familyIdShipped, LAST = 1, DATUM_OF = familyIdData, CORES = Set(1, 2), MAX_WRITES = 2).* from "./rollingUpdate_test"

  run lastIsLastTest = lastIsLast
}
