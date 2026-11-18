// Scenarios of the Source turn and the instances of its model that `check.sh` checks (sourceTurn.qnt).
//
// `scenarios` holds the scenarios over any instance; each instance module below binds the model's
// parameters and says what its scenarios must show. Simulation and Apalache run on these modules too.
module scenarios {
  import sourceTurn.* from "./sourceTurn"
  export sourceTurn.*

  /** A run of caller c1 of `p`, from reading its Source to its recording, a success without changed secrets. */
  action runsThrough(p: str): bool =
    read(p, "c1").then(answer(p, "c1", true, false)).then(storeSecrets(p, "c1")).then(record(p, "c1"))

  /** A container dies in a run; once its turn expired, another container takes it. */
  run deadTurnsAreTaken =
    init
      .then(push("p1", "c1", "s1"))
      .then(crash("p1"))
      .then((LASTS + 1).reps(_ => tick))
      .then(push("p2", "c1", "s1"))
      .expect(holds("p2", "s1"))

  /** Two runs of one Source, one after the other, both record: each a later turn than the last. */
  run twoRunsRecordInTurn =
    init
      .then(push("p1", "c1", "s1")).then(runsThrough("p1")).then(end("p1", "c1"))
      .then(push("p2", "c1", "s1")).then(runsThrough("p2"))
      .expect(cursor.get("s1") == 2 and ghost.recorded.get("s1") == 2 and noDoubleRecord)

  /**
   * A push waits on a dead holder's turn until its deadline, which the clock cannot pass; asking then,
   * it gets the turn (expired by now) or gives up.
   */
  run pushGetsTurnOrGivesUp =
    init
      .then(push("p1", "c1", "s1")).then(crash("p1"))
      .then(push("p2", "c1", "s1"))
      .then(WAITS_AT_MOST.reps(_ => tick))
      .expect(now - runs.get(("p2", "c1")).waitedSince == WAITS_AT_MOST and pushGetsTurnOrFails)
      .then(askAgain("p2", "c1"))
      .expect(runs.get(("p2", "c1")).phase != Waiting)

  /**
   * A run stalls in its plugin's call past its turn's expiry; another container takes the turn and
   * its plugin declares the attributes; then the stale run's plugin declares (or archives) its own,
   * replacing them without the turn.
   */
  run staleRunReplacesAttributes =
    init
      .then(push("p1", "c1", "s1")).then(read("p1", "c1"))
      .then((LASTS + 1).reps(_ => tick))
      .then(push("p2", "c1", "s1")).then(read("p2", "c1")).then(declare("p2", "c1"))
      .then(declare("p1", "c1"))

  /**
   * p1's run stalls past its turn's expiry before any renewal noticed the loss; p2 takes the turn,
   * refreshes the secrets and records; then p1, still believing it holds the turn, stores the
   * secrets its plugin answered, replacing p2's newer ones.
   */
  run staleRunReplacesSecrets =
    init
      .then(push("p1", "c1", "s1")).then(read("p1", "c1")).then(answer("p1", "c1", true, true))
      .then((LASTS + 1).reps(_ => tick))
      .then(push("p2", "c1", "s1")).then(read("p2", "c1")).then(answer("p2", "c1", true, true))
      .then(storeSecrets("p2", "c1")).then(record("p2", "c1")).then(end("p2", "c1"))
      .then(storeSecrets("p1", "c1"))

  /**
   * Due work begins on two containers at once, as the schedule and a trigger may; both find s1 due.
   * p1 polls it; then p2 gets the turn, which p1 ended, and polls it too unless it reads it afresh.
   */
  run dueWorkOnTwoContainers =
    init
      .then(beginRound("p1", "c1")).then(beginRound("p2", "c1"))
      .then(nextDue("p1", "c1", "s1")).then(runsThrough("p1")).then(end("p1", "c1"))
      .then(nextDue("p2", "c1", "s1")).then(runsThrough("p2"))

  /**
   * Two runs of s1 in one container, as a push and due work: the first stalls in its plugin's call
   * past its turn's expiry; the second, unless it queues behind the first, takes the turn under the
   * container's one holder; then the first, whose writes check only the holder, stores its secrets
   * in the second's turn.
   */
  run twoRunsInOneContainer =
    init
      .then(push("p1", "c1", "s1")).then(read("p1", "c1")).then(answer("p1", "c1", true, true))
      .then((LASTS + 1).reps(_ => tick))
      .then(push("p1", "c2", "s1"))
      .then(storeSecrets("p1", "c1"))
}

/** The model as checked: three containers of two callers, two Sources. */
module checked {
  import scenarios(
    PROCESSES = Set("p1", "p2", "p3"), CALLERS = Set("c1", "c2"), SOURCES = Set("s1", "s2"),
    LASTS = 3, WAITS_AT_MOST = 6, INTERVAL = 2, MAX_TIME = 8,
    GUARDED_WRITES = true, GUARDED_ATTRIBUTES = true, FRESH_DUE_CHECK = true, IN_MEMORY_QUEUE = true,
    TIMELY = false, CALL_TIMEOUT = 2, MAX_CRASHES = 1,
  ).*

  run deadTurnsAreTakenTest = deadTurnsAreTaken
  run twoRunsRecordInTurnTest = twoRunsRecordInTurn
  run pushGetsTurnOrGivesUpTest = pushGetsTurnOrGivesUp
  run staleRunIsSkippedTest = staleRunReplacesSecrets.expect(safety)
  run staleAttributesAreSkippedTest = staleRunReplacesAttributes.expect(safety)
  /** The second container reads s1 afresh, finds it no longer due and leaves it. */
  run dueSourceIsPolledOnceTest =
    init
      .then(beginRound("p1", "c1")).then(beginRound("p2", "c1"))
      .then(nextDue("p1", "c1", "s1")).then(runsThrough("p1")).then(end("p1", "c1"))
      .then(nextDue("p2", "c1", "s1")).then(read("p2", "c1"))
      .expect(ghost.lastAction == DidNoLongerDue and cursor.get("s1") == 1 and safety)
  /** The second run of s1 in p1 queues behind the first, which then writes nothing. */
  run secondRunQueuesTest =
    twoRunsInOneContainer.expect(runs.get(("p1", "c2")).phase == Queued and secrets.get("s1") == 0 and safety)
}

/** The code before the guarded writes (ADR-0008's amendment), kept to show their counterexample. */
module unguarded {
  import scenarios(
    PROCESSES = Set("p1", "p2"), CALLERS = Set("c1"), SOURCES = Set("s1"),
    LASTS = 3, WAITS_AT_MOST = 6, INTERVAL = 2, MAX_TIME = 8,
    GUARDED_WRITES = false, GUARDED_ATTRIBUTES = false, FRESH_DUE_CHECK = true, IN_MEMORY_QUEUE = true,
    TIMELY = false, CALL_TIMEOUT = 2, MAX_CRASHES = 2,
  ).*

  run staleRunReplacesSecretsTest = staleRunReplacesSecrets.expect(writeWithoutTurn and staleWrite)
  run staleRunReplacesAttributesTest = staleRunReplacesAttributes.expect(writeWithoutTurn and staleWrite)
}

/** Due work that does not read its Source afresh in its turn: a poll runs even if no longer due. */
module unchecked {
  import scenarios(
    PROCESSES = Set("p1", "p2"), CALLERS = Set("c1"), SOURCES = Set("s1"),
    LASTS = 3, WAITS_AT_MOST = 6, INTERVAL = 2, MAX_TIME = 8,
    GUARDED_WRITES = true, GUARDED_ATTRIBUTES = true, FRESH_DUE_CHECK = false, IN_MEMORY_QUEUE = true,
    TIMELY = false, CALL_TIMEOUT = 2, MAX_CRASHES = 0,
  ).*

  run dueSourceIsPolledTwiceTest = dueWorkOnTwoContainers.expect(not(pollsOncePerRound))
}

/** Runs of one Source in one container that ask the database without queueing in memory first. */
module unqueued {
  import scenarios(
    PROCESSES = Set("p1"), CALLERS = Set("c1", "c2"), SOURCES = Set("s1"),
    LASTS = 1, WAITS_AT_MOST = 6, INTERVAL = 2, MAX_TIME = 8,
    GUARDED_WRITES = true, GUARDED_ATTRIBUTES = true, FRESH_DUE_CHECK = true, IN_MEMORY_QUEUE = false,
    TIMELY = false, CALL_TIMEOUT = 2, MAX_CRASHES = 0,
  ).*

  run staleRunWritesInSecondRunsTurnTest =
    twoRunsInOneContainer.expect(writeWithoutTurn and staleWrite == false and secrets.get("s1") == 1)
}

/** Live containers that keep time, for the liveness bound: two containers of two callers, two Sources. */
module timely {
  import scenarios(
    PROCESSES = Set("p1", "p2"), CALLERS = Set("c1", "c2"), SOURCES = Set("s1", "s2"),
    LASTS = 3, WAITS_AT_MOST = 6, INTERVAL = 2, MAX_TIME = 20,
    GUARDED_WRITES = true, GUARDED_ATTRIBUTES = true, FRESH_DUE_CHECK = true, IN_MEMORY_QUEUE = true,
    TIMELY = true, CALL_TIMEOUT = 2, MAX_CRASHES = 0,
  ).*

  /**
   * Every due Source is polled within 10 ticks of becoming due, found by simulation: 9 is violated.
   * Most of it is a push of an earlier Source that waits for its turn (WAITS_AT_MOST): the round's
   * run of that Source queues behind the push in memory, and the round runs its Sources one after
   * the other. The rest is the call (CALL_TIMEOUT) and the clock moving past a turn just ended.
   */
  val dueSourceIsPolled: bool = dueSourcePolledWithin(10)
  /** Traces that run long enough for the bound to speak: the clock past INTERVAL + 10. */
  val clockPastBound: bool = now > INTERVAL + 10
}

/** The model Apalache checks exhaustively to a depth: the turns of Sources are independent, so one Source. */
module exhaustive {
  import scenarios(
    PROCESSES = Set("p1", "p2"), CALLERS = Set("c1"), SOURCES = Set("s1"),
    LASTS = 3, WAITS_AT_MOST = 6, INTERVAL = 2, MAX_TIME = 8,
    GUARDED_WRITES = true, GUARDED_ATTRIBUTES = true, FRESH_DUE_CHECK = true, IN_MEMORY_QUEUE = true,
    TIMELY = false, CALL_TIMEOUT = 2, MAX_CRASHES = 2,
  ).*
}
