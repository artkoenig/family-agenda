// Scenarios of the plugin call and the instances of its model that `check.sh` checks (pluginCall.qnt).
//
// `scenarios` holds the scenarios over any instance; each instance module below binds the model's
// parameters and says what its scenarios must show. Simulation and Apalache run on these modules too.
module scenarios {
  import pluginCall.* from "./pluginCall"
  export pluginCall.*

  /** The call of the run under way, as the core sent it. */
  val sent: Call = { id: turnRun.call, cursor: turnRun.read.cursor, token: turnRun.read.token }

  /** Outcomes of `handle`: 0 a temporary error, 1 a definite one, 2 an answer. */
  pure val temporary = 0
  pure val answers = 2

  /** The plugin answers the run's call; `refresh` refreshes the token. */
  action answered(refresh: bool): bool = handle(sent, refresh, answers)

  /** The core reads the answer of the run's own call. */
  action readAnswer: bool = all { replies.exists(r => r.call == turnRun.call), {
    nondet r = replies.filter(r => r.call == turnRun.call).oneOf()
    receive(r)
  } }

  /** A run whose call is lost: it times out, and its temporary error is recorded. */
  action unreachableRun: bool =
    start.then(loseCall(sent)).then(CALL_TIMEOUT.reps(_ => tick)).then(timeOut).then(recordFailed).then(end)

  /** A run that refreshes the token, stores it and records its cursor. */
  run refreshedRunRecords =
    init.then(start).then(answered(true)).then(readAnswer)
      .then(if (SECRETS_FIRST) storeSecrets else record)
      .then(if (SECRETS_FIRST) record else end)
      .expect(source.cursor == 1 and source.token == 2 and provider == 2 and safety)

  /**
   * An answer arriving after the timeout is never read: the run records a temporary error, and
   * the answer's cursor and refreshed token are not stored. The provider has issued a token the
   * core never got; the next run's call fails definitely, so the Source shows as Failing at once.
   */
  run lateAnswerIsDiscarded =
    init.then(start).then(answered(true)).then(CALL_TIMEOUT.reps(_ => tick))
      .then(timeOut).then(recordFailed)
      .expect(source.cursor == 0 and source.token == 1 and source.failingSince == 0 and safety)
      .then(end).then(start).then(handle(sent, false, answers)).then(readAnswer).then(recordFailed)
      .expect(source.failure == Definite and failing(source, now, FAILING_AFTER) and safety)

  /** A call delivered twice is handled twice; the core takes the first answer, and only once. */
  run duplicateCallIsTakenOnce =
    init.then(start).then(answered(false)).then(answered(false)).then(readAnswer).then(record).then(end)
      .expect(source.cursor == 1 and handled == 2 and replies.size() == 1 and safety)

  /** A temporary error writes the failure and nothing else; the cursor stays where it was. */
  run temporaryErrorWritesOnlyTheFailure =
    init.then(start).then(handle(sent, false, temporary)).then(readAnswer).then(recordFailed)
      .expect(source.cursor == 0 and source.token == 1 and source.failure == Temporary and source.failingSince == 0
        and not(failing(source, now, FAILING_AFTER)) and safety)

  /**
   * With secrets first, a run that loses its turn after storing the refreshed token keeps it,
   * though its cursor is not recorded: the next run reads the same data again, with a token the
   * provider accepts.
   */
  run lostTurnKeepsTheToken =
    init.then(start).then(answered(true)).then(readAnswer).then(storeSecrets).then(loseTurn).then(record)
      .expect(source.token == 2 and source.cursor == 0 and provider == 2 and safety)

  /**
   * A recording that fails after the plugin refreshed the token, such as the BlobStore failing.
   * With secrets first the token is kept; with secrets only in the recording it is dropped, and
   * the Source can no longer sign in: the counterexample.
   */
  run failedRecordingKeepsTheToken =
    init.then(start).then(answered(true)).then(readAnswer)
      .then(if (SECRETS_FIRST) storeSecrets.then(failOrigins) else failOrigins)
      .expect(if (SECRETS_FIRST) source.token == 2 and safety else source.token == 1 and not(refreshedTokenKept))

  /**
   * Liveness: a Source whose plugin is unreachable records a temporary error every run, since
   * every call ends at its timeout, and shows as Failing once the errors have lasted FAILING_AFTER.
   */
  run unreachableSourceShowsFailing =
    init.then(unreachableRun).expect(not(shownFailing))
      .then(unreachableRun).then(unreachableRun).then(unreachableRun)
      .expect(shownFailing and source.failingSince == 0 and safety)
}

/** The code: changed secrets are stored before the cursor. */
module checked {
  import scenarios(
    CALL_TIMEOUT = 2, FAILING_AFTER = 6, MAX_HANDLED = 4, MAX_RUNS = 4, MAX_TIME = 12,
    SECRETS_FIRST = true, TIMELY = false,
  ).*
  run refreshedRunRecordsTest = refreshedRunRecords
  run lateAnswerIsDiscardedTest = lateAnswerIsDiscarded
  run duplicateCallIsTakenOnceTest = duplicateCallIsTakenOnce
  run temporaryErrorWritesOnlyTheFailureTest = temporaryErrorWritesOnlyTheFailure
  run failedRecordingKeepsTheTokenTest = failedRecordingKeepsTheToken
  run unreachableSourceShowsFailingTest = unreachableSourceShowsFailing
  run lostTurnKeepsTheTokenTest = lostTurnKeepsTheToken
}

/** Changed secrets stored only with the cursor: a failing recording drops a refreshed token. */
module secretsLast {
  import scenarios(
    CALL_TIMEOUT = 2, FAILING_AFTER = 6, MAX_HANDLED = 4, MAX_RUNS = 4, MAX_TIME = 12,
    SECRETS_FIRST = false, TIMELY = false,
  ).*
  run refreshedRunRecordsTest = refreshedRunRecords
  run lateAnswerIsDiscardedTest = lateAnswerIsDiscarded
  run duplicateCallIsTakenOnceTest = duplicateCallIsTakenOnce
  run temporaryErrorWritesOnlyTheFailureTest = temporaryErrorWritesOnlyTheFailure
  run failedRecordingKeepsTheTokenTest = failedRecordingKeepsTheToken
  run unreachableSourceShowsFailingTest = unreachableSourceShowsFailing
}

/** The clock waits for the run, for the liveness bound. */
module timely {
  import scenarios(
    CALL_TIMEOUT = 2, FAILING_AFTER = 6, MAX_HANDLED = 6, MAX_RUNS = 6, MAX_TIME = 14,
    SECRETS_FIRST = true, TIMELY = true,
  ).*
  run unreachableSourceShowsFailingTest = unreachableSourceShowsFailing
}

/** For Apalache: fewer runs and handlings. */
module exhaustive {
  import scenarios(
    CALL_TIMEOUT = 1, FAILING_AFTER = 2, MAX_HANDLED = 2, MAX_RUNS = 2, MAX_TIME = 3,
    SECRETS_FIRST = true, TIMELY = false,
  ).*
}

module exhaustiveSecretsLast {
  import scenarios(
    CALL_TIMEOUT = 1, FAILING_AFTER = 2, MAX_HANDLED = 2, MAX_RUNS = 2, MAX_TIME = 3,
    SECRETS_FIRST = false, TIMELY = false,
  ).*
}
