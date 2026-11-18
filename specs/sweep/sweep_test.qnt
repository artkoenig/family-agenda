// Scenarios of the sweep and the instances of its model that `check.sh` checks (sweep.qnt).
module scenarios {
  import sweep.* from "./sweep"
  export sweep.*

  /** A writer replacing the reference with secret `id`, start to finish. */
  action replaceWith(w: str, id: int): bool =
    begin(w, Replace).then(store(w, id)).then(commit(w)).then(removeOld(w))

  /** Worker `k` sweeps from start to listing, reading clock and references in the code's order. */
  action sweepUntilListed(k: str): bool =
    start(k).then(readClock(k)).then(readReferences(k)).then(list(k))

  action sweepUntilListedOld(k: str): bool =
    start(k).then(readReferences(k)).then(readClock(k)).then(list(k))

  /** A crash between storing a secret and committing it leaves an orphan; the sweep removes it once old. */
  run orphanIsSwept =
    init.then(begin("admin", Replace)).then(store("admin", 1)).then(crash("admin"))
      .then((AGE + 1).reps(_ => tick))
      .then(if (CLOCK_FIRST) sweepUntilListed("w1") else sweepUntilListedOld("w1"))
      .then(removeOne("w1", 1)).then(finish("w1"))
      .expect(not(secrets.get(1).stored) and safety and sweepRemovesOrphans)

  /** A secret stored by a writer still running is younger than the age, and spared. */
  run runningIsSpared =
    init.then(begin("admin", Replace)).then(store("admin", 1)).then(tick)
      .then(if (CLOCK_FIRST) sweepUntilListed("w1") else sweepUntilListedOld("w1"))
      .expect(sweepers.get("w1").pending == Set())
      .then(finish("w1")).then(commit("admin")).then(removeOld("admin"))
      .expect(reference == 1 and secrets.get(1).stored and safety)

  /** The caller removes the secret it replaced after its commit. */
  run replacedIsRemoved =
    init.then(replaceWith("admin", 1)).then(replaceWith("run", 2))
      .expect(reference == 2 and not(secrets.get(1).stored) and safety)

  /** A worker dying mid-sweep loses its job by its heartbeat, and another sweeps (liveness). */
  run deadWorkerSweepsAgain =
    init.then(start("w1")).then(die("w1")).then(HEARTBEAT.reps(_ => tick)).then(expire)
      .then(start("w2"))
      .expect(not(sweepers.get("w2").idle) and oneSweep)

  /** A worker stalling past its heartbeat loses its job, and another sweeps while it resumes. */
  run stalledWorkerSweepsTwice =
    init.then(start("w1")).then(pause("w1")).then(HEARTBEAT.reps(_ => tick)).then(expire)
      .then(start("w2")).then(resume("w1"))
      .expect(not(oneSweep) and safety)

  /**
   * The first counterexample: a sweep reads the references and stalls; meanwhile an Admin replaces
   * the secret, and an hour passes; the sweep resumes, reads the clock, and judges the new secret by
   * its old snapshot: unreferenced and older than an hour, so it removes what the Source refers to.
   */
  run stalledBetweenReads =
    init.then(start("w1"))
      .then(if (CLOCK_FIRST) readClock("w1") else readReferences("w1"))
      .then(pause("w1"))
      .then(replaceWith("admin", 1))
      .then((AGE + 1).reps(_ => tick))
      .then(resume("w1"))
      .then(if (CLOCK_FIRST) readReferences("w1") else readClock("w1"))
      .then(list("w1"))

  /**
   * The second counterexample: a run refreshing another secret field keeps this one, an Admin
   * replaces it during the run's call, committing the new secret and removing the old; the run then
   * writes the whole `secret_refs` it read, the removed secret with it.
   */
  run keptWhileReplaced =
    init.then(replaceWith("admin", 1))
      .then(begin("run", Keep)).then(replaceWith("admin", 2))
      .then(commit("run")).then(removeOld("run"))

  /** A writer outlasting the age: the sweep removes the secret it is about to commit. */
  run outlastingWriter =
    init.then(begin("admin", Replace)).then(store("admin", 1))
      .then((AGE + 1).reps(_ => tick))
      .then(if (CLOCK_FIRST) sweepUntilListed("w1") else sweepUntilListedOld("w1"))
      .then(removeOne("w1", 1))
}

/** The code with the fixes, its workers stalling: the sweep reads the clock first, a commit writes only what it changes. */
module checked {
  import scenarios(IDS = Set(1, 2, 3, 4), WRITERS = Set("admin", "run"), WORKERS = Set("w1", "w2"), AGE = 2, LONGEST = 2, EXPIRE = 2, HEARTBEAT = 1, STALLS = true, CLOCK_FIRST = true, CHANGED_ONLY = true, MAX_TIME = 10).*

  run orphanIsSweptTest = orphanIsSwept
  run runningIsSparedTest = runningIsSpared
  run replacedIsRemovedTest = replacedIsRemoved
  run deadWorkerSweepsAgainTest = deadWorkerSweepsAgain
  run stalledWorkerSweepsTwiceTest = stalledWorkerSweepsTwice
  /** Read after the clock, the references include the new secret, which the sweep spares. */
  run stalledBetweenReadsTest = stalledBetweenReads.expect(sweepers.get("w1").pending == Set() and safety)
  /** The run leaves the reference the Admin committed. */
  run keptWhileReplacedTest = keptWhileReplaced.expect(reference == 2 and safety)
}

/** Workers that never stall: two of them never sweep at once. */
module steady {
  import scenarios(IDS = Set(1, 2, 3, 4), WRITERS = Set("admin", "run"), WORKERS = Set("w1", "w2"), AGE = 2, LONGEST = 2, EXPIRE = 2, HEARTBEAT = 1, STALLS = false, CLOCK_FIRST = true, CHANGED_ONLY = true, MAX_TIME = 10).*

  run deadWorkerSweepsAgainTest = deadWorkerSweepsAgain
}

/** The sweep before this spec: it reads the references before the clock. */
module unfixedClock {
  import scenarios(IDS = Set(1, 2, 3, 4), WRITERS = Set("admin", "run"), WORKERS = Set("w1", "w2"), AGE = 2, LONGEST = 2, EXPIRE = 2, HEARTBEAT = 1, STALLS = true, CLOCK_FIRST = false, CHANGED_ONLY = true, MAX_TIME = 10).*

  run stalledBetweenReadsTest = stalledBetweenReads.then(removeOne("w1", 1))
    .expect(not(sweepSparesReferenced) and not(noDanglingReference))
}

/** The writes before this spec: an edit or a run writes the whole `secret_refs` it read. */
module unfixedWrite {
  import scenarios(IDS = Set(1, 2, 3, 4), WRITERS = Set("admin", "run"), WORKERS = Set("w1", "w2"), AGE = 2, LONGEST = 2, EXPIRE = 2, HEARTBEAT = 1, STALLS = true, CLOCK_FIRST = true, CHANGED_ONLY = false, MAX_TIME = 10).*

  run keptWhileReplacedTest = keptWhileReplaced.expect(reference == 1 and not(noDanglingReference))
}

/** A writer may outlast the age: then the sweep removes what it is about to commit. */
module outlasting {
  import scenarios(IDS = Set(1, 2, 3, 4), WRITERS = Set("admin", "run"), WORKERS = Set("w1", "w2"), AGE = 2, LONGEST = 4, EXPIRE = 2, HEARTBEAT = 1, STALLS = true, CLOCK_FIRST = true, CHANGED_ONLY = true, MAX_TIME = 10).*

  run outlastingWriterTest = outlastingWriter.expect(not(sweepSparesReferenced) and not(runningKeepTheirs))
}

/**
 * The models Apalache checks exhaustively to a depth. Safety holds per sweep, whatever others run
 * at once, so it is checked with one worker; that two never run at once, with two and one writer.
 */
module exhaustive {
  import scenarios(IDS = Set(1, 2), WRITERS = Set("admin", "run"), WORKERS = Set("w1"), AGE = 1, LONGEST = 1, EXPIRE = 2, HEARTBEAT = 1, STALLS = true, CLOCK_FIRST = true, CHANGED_ONLY = true, MAX_TIME = 3).*
}
module exhaustiveSteady {
  import scenarios(IDS = Set(1), WRITERS = Set("admin"), WORKERS = Set("w1", "w2"), AGE = 1, LONGEST = 1, EXPIRE = 2, HEARTBEAT = 1, STALLS = false, CLOCK_FIRST = true, CHANGED_ONLY = true, MAX_TIME = 3).*
}
module exhaustiveUnfixedClock {
  import scenarios(IDS = Set(1), WRITERS = Set("admin"), WORKERS = Set("w1"), AGE = 1, LONGEST = 1, EXPIRE = 2, HEARTBEAT = 1, STALLS = true, CLOCK_FIRST = false, CHANGED_ONLY = true, MAX_TIME = 3).*
}
module exhaustiveUnfixedWrite {
  import scenarios(IDS = Set(1, 2), WRITERS = Set("admin", "run"), WORKERS = Set("w1"), AGE = 1, LONGEST = 1, EXPIRE = 2, HEARTBEAT = 1, STALLS = true, CLOCK_FIRST = true, CHANGED_ONLY = false, MAX_TIME = 3).*
}
module exhaustiveOutlasting {
  import scenarios(IDS = Set(1, 2), WRITERS = Set("admin", "run"), WORKERS = Set("w1"), AGE = 1, LONGEST = 3, EXPIRE = 2, HEARTBEAT = 1, STALLS = true, CLOCK_FIRST = true, CHANGED_ONLY = true, MAX_TIME = 3).*
}
