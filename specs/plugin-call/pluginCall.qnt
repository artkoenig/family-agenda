// The core calling a stateless plugin over an unreliable network (ADR-0001).
//
// One run of one Source at a time: the Source turn keeps runs of a Source apart (ADR-0008,
// specs/source-turn), so this spec only lets the run lose its turn at any point. Calls and answers
// travel through a message soup in which they may be lost, delivered twice or late. The plugin
// answers a call with a new Sync Cursor and, when it refreshed the Source's token at its provider,
// the new token; or with an error. The provider accepts only the token it issued last, so a
// refreshed token the core drops leaves the Source unable to sign in.
//
// Actions and the code they stand for (application: polling.ts; api: plugin-containers/transport.ts;
// adapters: PostgresSourceRepository, PostgresItemRepository.recordRun):
//   start          takeTurn, sources.findById, then callPlugin sending the call
//   handle         the plugin handling a call it received, perhaps a second time
//   loseCall, loseAnswer   the network dropping one
//   receive        fetch resolving with the answer of the run's own call; transport's errorOf and
//                  the response schema turn it into ok, or a temporary or definite error
//   timeOut        AbortSignal.timeout: no answer within the call's timeout, or the container
//                  unreachable, is a temporary error; a later answer is never read
//   recordFailed   SourceRepository.recordFailedRunInTurn
//   storeSecrets   storeChangedSecrets: SourceRepository.replaceSecretsInTurn
//   failOrigins    buildOrigins or recordRun throwing for another reason than the turn, such as
//                  the BlobStore failing
//   record         ItemRepository.recordRun: the Sync Cursor, last success, failure cleared
//   end            SourceRunTurns.end
//   loseTurn       another container taking the run's turn over (it expired unrenewed)
//
// Not covered: what the other container does in the turn it took (specs/source-turn), pushed
// payloads (a push is a run like a poll here), the Source Records themselves (specs/source-records),
// the other endpoints (description, field choices, setup steps), and singleton plugins
// (specs/singleton-plugin). The provider issues a new token only on a refresh; a duplicated call
// refreshing twice is shown, not prevented (ADR-0001's amendment).
module pluginCall {
  // ---- Parameters -----------------------------------------------------------------------------

  /** How long a call may go unanswered before it is a temporary error, in ticks. */
  const CALL_TIMEOUT: int
  /** How long temporary errors may last before the Source is Failing (failingAfterMs). */
  const FAILING_AFTER: int
  /** How often the plugin may handle calls in one execution, so that the state space is finite. */
  const MAX_HANDLED: int
  /** How many runs one execution may start. */
  const MAX_RUNS: int
  /** Bounds the clock. */
  const MAX_TIME: int
  /**
   * Whether changed secrets are stored in their own write before the Sync Cursor (the code).
   * False stores them only with the cursor, in recordRun: the counterexample of ADR-0001's
   * amendment, where a failing recording drops a refreshed token.
   */
  const SECRETS_FIRST: bool
  /**
   * Whether the clock waits for the run: it does not move on while a call has lasted its timeout,
   * nor while the run owes a write, which takes no time. For the liveness bound; false lets a
   * container stall anywhere, as for safety.
   */
  const TIMELY: bool

  // ---- State ----------------------------------------------------------------------------------

  type ErrorKind = Temporary | Definite

  /** What the plugin answers: `token` 0 when it did not change the Source's secrets. */
  type Answer = Ok({ cursor: int, token: int }) | Failed(ErrorKind)

  /** What the core sends: the Source's configuration, secrets and cursor as it read them. */
  type Call = { id: int, cursor: int, token: int }
  type Reply = { call: int, answer: Answer }

  /** The Source's stored state, and its failure (`failingSince` -1 when it does not fail). */
  type Source = { cursor: int, token: int, failingSince: int, failure: ErrorKind }

  /**
   * Where the run is: Idle (none), Called (waiting for its answer), Answered, SecretsStored
   * (changed secrets written, the recording to come), Done (written, failed or lost; turn not yet
   * ended).
   */
  type Phase = Idle | Called | Answered | SecretsStored | Done

  type Run = {
    phase: Phase,
    call: int,
    startedAt: int,
    read: Source,
    answer: Answer,
    /** Whether the run held its turn from start to its last write: its turn was never taken over. */
    kept: bool,
  }

  type Did = DidInit | DidTick | DidStart | DidHandle | DidLoseCall | DidLoseAnswer | DidReceive | DidTimeOut
    | DidRecordFailed | DidStoreSecrets | DidFailOrigins | DidRecord | DidLost | DidEnd | DidLoseTurn

  /**
   * Ghost state: the last action; the calls whose answer the core took; where the stored cursor
   * and token came from (call 0: the start); whether a failed
   * run changed more than the failure, a token the run received in its kept turn was dropped; how many runs started.
   */
  type Ghost = {
    lastAction: Did,
    taken: Set[int],
    cursorFrom: int,
    tokenFrom: int,
    halfWritten: bool,
    droppedToken: bool,
    runs: int,
  }

  var now: int
  var source: Source
  /** The token the provider accepts: the one it issued last. */
  var provider: int
  var calls: Set[Call]
  var replies: Set[Reply]
  var handled: int
  var turnRun: Run
  /** Whether the run's turn is still its own. */
  var turnHeld: bool
  var ghost: Ghost

  // ---- Functional logic -----------------------------------------------------------------------

  /** The status the Admin sees, as sourceStatus: Failing at once for a definite error, else after FAILING_AFTER. */
  pure def failing(s: Source, at: int, after: int): bool =
    s.failingSince >= 0 and (s.failure == Definite or at - s.failingSince >= after)

  /** The failure after a failed run started at `at`: since stays, definite stays definite (failedRunRecorded). */
  pure def withFailure(s: Source, kind: ErrorKind, at: int): Source = {
    ...s,
    failingSince: if (s.failingSince >= 0) s.failingSince else at,
    failure: if (s.failingSince >= 0 and s.failure == Definite) Definite else kind,
  }

  /** The token an answer changed, 0 if none or no success. */
  pure def tokenOf(a: Answer): int = match a {
    | Ok(o) => o.token
    | Failed(_) => 0
  }

  /** The kind of a failed answer. */
  pure def kindOf(a: Answer): ErrorKind = match a {
    | Ok(_) => Temporary
    | Failed(k) => k
  }

  pure def isOk(a: Answer): bool = match a {
    | Ok(_) => true
    | Failed(_) => false
  }

  /** The Source after a recorded run: the answer's cursor, the token if `withToken`, no failure. */
  pure def recorded(s: Source, a: Answer, withToken: bool): Source = match a {
    | Ok(o) => {
        cursor: o.cursor,
        token: if (withToken and o.token != 0) o.token else s.token,
        failingSince: -1,
        failure: Temporary,
      }
    | Failed(_) => s
  }

  // ---- Helpers --------------------------------------------------------------------------------

  val noRun: Run = {
    phase: Idle, call: 0, startedAt: 0, read: { cursor: 0, token: 0, failingSince: -1, failure: Temporary },
    answer: Failed(Temporary), kept: true,
  }

  /** Whether the run owes a step that takes no time: a write, or ending its call at the timeout. */
  val owesStep: bool =
    Set(Answered, SecretsStored, Done).contains(turnRun.phase)
      or (turnRun.phase == Called and now - turnRun.startedAt >= CALL_TIMEOUT)

  action did(name: Did): bool = ghost' = { ...ghost, lastAction: name }

  action keepNetwork: bool = all { calls' = calls, replies' = replies, handled' = handled, provider' = provider }

  /** The run ends without a write: its turn was lost, or a write failed. */
  action endsUnwritten(name: Did): bool = all {
    turnRun' = { ...turnRun, phase: Done },
    source' = source, turnHeld' = turnHeld,
    ghost' = { ...ghost, lastAction: name,
               droppedToken: ghost.droppedToken or (turnRun.kept and turnHeld and tokenOf(turnRun.answer) != 0
                 and turnRun.phase == Answered) },
  }

  // ---- Actions --------------------------------------------------------------------------------

  action init: bool = all {
    now' = 0,
    source' = { cursor: 0, token: 1, failingSince: -1, failure: Temporary },
    provider' = 1,
    calls' = Set(),
    replies' = Set(),
    handled' = 0,
    turnRun' = noRun,
    turnHeld' = false,
    ghost' = { lastAction: DidInit, taken: Set(), cursorFrom: 0, tokenFrom: 0,
               halfWritten: false, droppedToken: false, runs: 0 },
  }

  action tick: bool = all {
    now < MAX_TIME,
    not(TIMELY and owesStep),
    now' = now + 1,
    source' = source, turnRun' = turnRun, turnHeld' = turnHeld, keepNetwork, did(DidTick),
  }

  /** The run takes the turn, reads the Source and sends the call. */
  action start: bool = {
    val id = ghost.runs + 1
    all {
      turnRun.phase == Idle,
      ghost.runs < MAX_RUNS,
      turnRun' = { phase: Called, call: id, startedAt: now, read: source, answer: Failed(Temporary), kept: true },
      calls' = calls.union(Set({ id: id, cursor: source.cursor, token: source.token })),
      turnHeld' = true,
      source' = source, now' = now, replies' = replies, handled' = handled, provider' = provider,
      ghost' = { ...ghost, lastAction: DidStart, runs: id },
    }
  }

  /**
   * The plugin handles a call, which stays in the network: it may arrive again. With the token
   * the provider accepts it may refresh it; with another one the provider refuses it, a definite
   * error. Otherwise it may fail temporarily (5xx, or a 4xx not marked definite), definitely
   * (4xx definite, or an answer the core's schema rejects), or answer.
   */
  action handle(c: Call, refresh: bool, outcome: int): bool = {
    val answer =
      if (c.token != provider) Failed(Definite)
      else if (outcome == 0) Failed(Temporary)
      else if (outcome == 1) Failed(Definite)
      else Ok({ cursor: c.cursor + 1, token: if (refresh) provider + 1 else 0 })
    all {
      handled < MAX_HANDLED,
      provider' = if (tokenOf(answer) != 0) tokenOf(answer) else provider,
      replies' = replies.union(Set({ call: c.id, answer: answer })),
      handled' = handled + 1,
      calls' = calls,
      now' = now, source' = source, turnRun' = turnRun, turnHeld' = turnHeld, did(DidHandle),
    }
  }

  action loseCall(c: Call): bool = all {
    calls' = calls.exclude(Set(c)), replies' = replies, handled' = handled, provider' = provider,
    now' = now, source' = source, turnRun' = turnRun, turnHeld' = turnHeld, did(DidLoseCall),
  }

  action loseAnswer(r: Reply): bool = all {
    replies' = replies.exclude(Set(r)), calls' = calls, handled' = handled, provider' = provider,
    now' = now, source' = source, turnRun' = turnRun, turnHeld' = turnHeld, did(DidLoseAnswer),
  }

  /** The answer of the run's own call arrives before its timeout; any other answer finds no reader. */
  action receive(r: Reply): bool = all {
    turnRun.phase == Called, r.call == turnRun.call, now - turnRun.startedAt < CALL_TIMEOUT,
    turnRun' = { ...turnRun, phase: Answered, answer: r.answer },
    source' = source, now' = now, turnHeld' = turnHeld, keepNetwork,
    ghost' = { ...ghost, lastAction: DidReceive, taken: ghost.taken.union(Set(r.call)) },
  }

  action timeOut: bool = all {
    turnRun.phase == Called, now - turnRun.startedAt >= CALL_TIMEOUT,
    turnRun' = { ...turnRun, phase: Answered, answer: Failed(Temporary) },
    source' = source, now' = now, turnHeld' = turnHeld, keepNetwork, did(DidTimeOut),
  }

  /** recordFailedRunInTurn: only the failure, only in the turn. */
  action recordFailed: bool = all {
    turnRun.phase == Answered, not(isOk(turnRun.answer)),
    now' = now, keepNetwork,
    if (turnHeld) {
            val failed = source.withFailure(kindOf(turnRun.answer), turnRun.startedAt)
            all {
              source' = failed,
              turnRun' = { ...turnRun, phase: Done },
              turnHeld' = turnHeld,
              ghost' = { ...ghost, lastAction: DidRecordFailed,
                         halfWritten: ghost.halfWritten or failed.cursor != turnRun.read.cursor or failed.token != turnRun.read.token },
            }
          } else endsUnwritten(DidLost),
  }

  /** storeChangedSecrets: the refreshed token, in its own transaction, before the recording. */
  action storeSecrets: bool = all {
    SECRETS_FIRST, turnRun.phase == Answered, tokenOf(turnRun.answer) != 0,
    now' = now, keepNetwork,
    if (turnHeld) all {
      source' = { ...source, token: tokenOf(turnRun.answer) },
      turnRun' = { ...turnRun, phase: SecretsStored },
      turnHeld' = turnHeld,
      ghost' = { ...ghost, lastAction: DidStoreSecrets, tokenFrom: turnRun.call },
    } else endsUnwritten(DidLost),
  }

  /** Whether the run is ready for its recording: answered ok, its changed secrets stored if they go first. */
  val readyToRecord: bool =
    (turnRun.phase == SecretsStored)
      or (turnRun.phase == Answered and isOk(turnRun.answer) and (not(SECRETS_FIRST) or tokenOf(turnRun.answer) == 0))

  /** buildOrigins or recordRun throwing for another reason than the turn: nothing of the recording is kept. */
  action failOrigins: bool = all {
    readyToRecord,
    now' = now, keepNetwork,
    endsUnwritten(DidFailOrigins),
  }

  /** recordRun: in the turn, the cursor (and, without SECRETS_FIRST, the token); the failure cleared. */
  action record: bool = all {
    readyToRecord,
    now' = now, keepNetwork,
    if (turnHeld) all {
      source' = recorded(source, turnRun.answer, not(SECRETS_FIRST)),
      turnRun' = { ...turnRun, phase: Done },
      turnHeld' = turnHeld,
      ghost' = { ...ghost, lastAction: DidRecord, cursorFrom: turnRun.call,
                 tokenFrom: if (not(SECRETS_FIRST) and tokenOf(turnRun.answer) != 0) turnRun.call else ghost.tokenFrom },
    } else endsUnwritten(DidLost),
  }

  action end: bool = all {
    turnRun.phase == Done,
    turnRun' = noRun, turnHeld' = false,
    source' = source, now' = now, keepNetwork, did(DidEnd),
  }

  /** Another container takes the turn over: from now on the run's writes find it lost. */
  action loseTurn: bool = all {
    turnRun.phase != Idle, turnHeld,
    turnHeld' = false, turnRun' = { ...turnRun, kept: false },
    source' = source, now' = now, keepNetwork, did(DidLoseTurn),
  }

  action step: bool = any {
    tick, start, timeOut, recordFailed, storeSecrets, failOrigins, record, end, loseTurn,
    nondet c = oneOf(if (calls == Set()) Set({ id: 0, cursor: 0, token: 0 }) else calls)
    nondet refresh = oneOf(Set(true, false))
    nondet outcome = oneOf(0.to(3))
    all { calls.contains(c), handle(c, refresh, outcome) },
    nondet c = oneOf(if (calls == Set()) Set({ id: 0, cursor: 0, token: 0 }) else calls)
    all { calls.contains(c), loseCall(c) },
    nondet r = oneOf(if (replies == Set()) Set({ call: 0, answer: Failed(Temporary) }) else replies)
    all { replies.contains(r), any { receive(r), loseAnswer(r) } },
  }

  // ---- Properties -----------------------------------------------------------------------------

  /** A stored cursor or token comes from an answer the core took, never from a late, lost or foreign one. */
  val discardedNeverStored: bool =
    (ghost.cursorFrom == 0 or ghost.taken.contains(ghost.cursorFrom))
      and (ghost.tokenFrom == 0 or ghost.taken.contains(ghost.tokenFrom))

  /** A failed run, temporary or definite, writes its failure and nothing else. */
  val noHalfWrite: bool = not(ghost.halfWritten)

  /** A token the plugin refreshed is not dropped by a run that kept its turn (ADR-0001's amendment). */
  val refreshedTokenKept: bool = not(ghost.droppedToken)

  val safety: bool = discardedNeverStored and noHalfWrite and refreshedTokenKept

  /**
   * Liveness bound: a run's call ends within its timeout, so a Source whose plugin keeps failing
   * records its failure every run. With TIMELY only.
   */
  val callEndsInTime: bool = turnRun.phase != Called or now - turnRun.startedAt <= CALL_TIMEOUT

  // ---- Witnesses ------------------------------------------------------------------------------

  val recordedRun: bool = ghost.lastAction == DidRecord
  val secretsWithoutCursor: bool = turnRun.phase == Done and ghost.tokenFrom == turnRun.call and ghost.cursorFrom != turnRun.call
  val lateAnswerIgnored: bool = replies.exists(r => r.call < turnRun.call or (r.call == turnRun.call and turnRun.phase != Called))
  val duplicateHandled: bool = handled > ghost.runs
  val timedOut: bool = ghost.lastAction == DidTimeOut
  val shownFailing: bool = failing(source, now, FAILING_AFTER)
  val lostWrite: bool = ghost.lastAction == DidLost
}
