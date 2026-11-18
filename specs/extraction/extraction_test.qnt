// Scenarios of extraction and the instances of its model that `check.sh` checks (extraction.qnt).
//
// `scenarios` holds the scenarios over any instance; each instance module below binds the model's
// parameters and says what its scenarios must show. Simulation and Apalache run on these modules too.
module scenarios {
  import extraction.* from "./extraction"
  export extraction.*

  /** Worker `w` turns to its next message, reads it once, and has the answer `o`. */
  action readsOnce(w: str, o: Outcome): bool = check(w).then(call(w)).then(answer(w, o))

  /** Worker `w` reads its message once more, the answer `o`; checking it first, if the code does. */
  action readsAgain(w: str, o: Outcome): bool =
    (if (CHECK_BEFORE_READING) check(w).then(call(w)) else call(w)).then(answer(w, o))

  /** A run of `w` whose first message fails with `o`: a timeout ends the run there. */
  action failsFirst(w: str, o: Outcome): bool = take(w).then(readsOnce(w, o)).then(recordFailure(w))

  /** A run of `w` whose first two messages fail with invalid output; the run then ends. */
  action failsTwo(w: str): bool =
    take(w).then(readsOnce(w, InvalidOutput)).then(recordFailure(w))
      .then(readsOnce(w, InvalidOutput)).then(recordFailure(w)).then(end(w))

  /** A message whose Items fail a check is read a second time, and that reading is recorded. */
  action secondReadingCounts: bool =
    init.then(take("w1")).then(readsOnce("w1", FailingChecks)).then(readsAgain("w1", FailingChecks)).then(record("w1"))

  /** The schedule and a trigger take the same batch; w1 reads message 1, then w2 turns to it. */
  action overlappingRuns: bool =
    init.then(take("w1")).then(take("w2")).then(readsOnce("w1", Passing)).then(record("w1")).then(check("w2"))

  /** Both runs turn to message 1 before either recorded, so both read it: the second writes nothing. */
  action simultaneousReadings: bool =
    init.then(take("w1")).then(take("w2"))
      .then(readsOnce("w1", Passing)).then(readsOnce("w2", Passing))
      .then(record("w1")).then(record("w2"))
}

/**
 * The design: failed attempts counted, a message checked before each reading. Message 1 times out
 * on every reading, message 2 answers invalid output on every one.
 */
module fixed {
  import scenarios(
    WORKERS = Set("w1", "w2"), MESSAGES = 3, BATCH = 2, ALWAYS_TIME_OUT = Set(1), ALWAYS_INVALID = Set(2),
    MAX_FAILURES = 2, CHECK_BEFORE_READING = true, MAX_CRASHES = 1, MAX_OUTAGES = 1, MAX_RETRIES = 1,
  ).*

  /**
   * Message 1 times out twice and fails; then message 2's invalid output fails it too, and the run
   * goes on to message 3. An Admin retries message 1, which waits again with no failures.
   */
  run failedMessagesAreSkippedTest =
    init
      .then(failsFirst("w1", Timeout)).then(failsFirst("w1", Timeout))
      .expect(messages.get(1).failed)
      .then(take("w1")).expect(runs.get("w1").batch == List(2, 3))
      .then(readsOnce("w1", InvalidOutput)).then(recordFailure("w1")).then(readsOnce("w1", Passing)).then(record("w1"))
      .then(end("w1"))
      .then(failsFirst("w1", InvalidOutput)).then(end("w1"))
      .expect(messages.get(2).failed and messages.get(3).processed and allSettled)
      .then(retry(1))
      .expect(not(messages.get(1).failed) and messages.get(1).failures == 0 and safety)
}

/** The code before this spec: no attempt counted. Message 1 times out on every reading. */
module unboundedTimeout {
  import scenarios(
    WORKERS = Set("w1", "w2"), MESSAGES = 3, BATCH = 2, ALWAYS_TIME_OUT = Set(1), ALWAYS_INVALID = Set(),
    MAX_FAILURES = 0, CHECK_BEFORE_READING = false, MAX_CRASHES = 1, MAX_OUTAGES = 1, MAX_RETRIES = 1,
  ).*

  /** Every run ends at message 1, which never fails: messages 2 and 3 are never read. */
  run timeoutBlocksTheRestTest =
    init.then(3.reps(_ => failsFirst("w1", Timeout)))
      .expect(not(messages.get(1).failed) and not(messages.get(2).processed) and ghost.passedOver.get(2) == 3)
}

/** The code before this spec, with BATCH messages that answer invalid output on every reading. */
module unboundedInvalid {
  import scenarios(
    WORKERS = Set("w1", "w2"), MESSAGES = 3, BATCH = 2, ALWAYS_TIME_OUT = Set(), ALWAYS_INVALID = Set(1, 2),
    MAX_FAILURES = 0, CHECK_BEFORE_READING = false, MAX_CRASHES = 1, MAX_OUTAGES = 1, MAX_RETRIES = 1,
  ).*

  /** Messages 1 and 2 fill every batch and never fail: message 3 is never read. */
  run invalidFillsTheBatchTest =
    init.then(3.reps(_ => failsTwo("w1")))
      .expect(not(messages.get(3).processed) and ghost.passedOver.get(3) == 3)
}

/** The code before this spec, without failing messages: nothing checked before a reading. */
module unchecked {
  import scenarios(
    WORKERS = Set("w1", "w2"), MESSAGES = 2, BATCH = 2, ALWAYS_TIME_OUT = Set(), ALWAYS_INVALID = Set(),
    MAX_FAILURES = 0, CHECK_BEFORE_READING = false, MAX_CRASHES = 1, MAX_OUTAGES = 1, MAX_RETRIES = 1,
  ).*

  /** The second run reads message 1 again, read by the first meanwhile. */
  run readsReadMessageTest = overlappingRuns.then(call("w2")).expect(not(processedNotReadAgain))
}

/** The model Apalache checks exhaustively to a depth: two workers, two messages. */
module exhaustive {
  import scenarios(
    WORKERS = Set("w1", "w2"), MESSAGES = 2, BATCH = 2, ALWAYS_TIME_OUT = Set(), ALWAYS_INVALID = Set(),
    MAX_FAILURES = 2, CHECK_BEFORE_READING = true, MAX_CRASHES = 1, MAX_OUTAGES = 1, MAX_RETRIES = 1,
  ).*

  run secondReadingCountsTest =
    secondReadingCounts.expect(messages.get(1).processed and ghost.mostReadings == 2 and safety)
  /** The second run skips message 1, read by the first meanwhile. */
  run overlappingRunsTest = overlappingRuns.expect(ghost.lastAction == DidSkip and safety)
  run simultaneousReadingsTest = simultaneousReadings.expect(ghost.lastAction == DidRecordDiscarded and safety)
}
