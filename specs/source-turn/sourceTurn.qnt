// Runs of one Source take turns, kept in the Family's database (ADR-0008).
//
// Each action is one statement or one transaction of the core, so that the checker interleaves
// them as the database may: taking the turn (an upsert that takes over an expired row), renewing
// it, reading the Source, the plugin's answer, the writes of a run, and ending the turn. Time is a
// counter the database's now() follows; containers may stall, die or lose a renewal at any point.
//
// Actions and the code they stand for (application: polling.ts; adapters: PostgresSourceRunTurns,
// PostgresSourceRepository, PostgresItemRepository.recordRun):
//   start, askAgain  takeTurn: SourceRunTurns.take, once for a poll, repeatedly for a push
//   read             sources.findById at the start of the run, then the plugin's call
//   declare          the plugin declaring or archiving the Source's attributes during its call:
//                    SourceRepository.declareAttributes, archiveAttribute
//   renew            the renewal interval: SourceRunTurns.renew, setting `lost` when it fails
//   answer           the plugin's answer: ok or a failure, with changed secrets or without
//   recordFailed     SourceRepository.recordFailedRunInTurn
//   storeSecrets     storeChangedSecrets: SourceRepository.replaceSecretsInTurn
//   record           ItemRepository.recordRun, locking the turn's row FOR UPDATE
//   end              SourceRunTurns.end
//   crash            a container that dies; its turns stay until they expire
module sourceTurn {
  // ---- Parameters -----------------------------------------------------------------------------

  /** The api containers of one Family. */
  const PROCESSES: Set[str]
  /** The Family's Sources. */
  const SOURCES: Set[str]
  /** How long a turn lasts unrenewed, in ticks of the database's clock. */
  const LASTS: int
  /** How long a pushed payload asks for the turn before it fails temporarily. */
  const WAITS_AT_MOST: int
  /** Bounds the clock, so that the state space is finite. */
  const MAX_TIME: int
  /**
   * Whether the writes a run makes besides its Source Records and Sync Cursor (changed secrets, a
   * failed run) check the turn in the database, as the recording does. False is the code as it was
   * before this spec: those writes only checked the in-memory `lost` flag that renewals set.
   */
  const GUARDED_WRITES: bool
  /**
   * Whether the writes of a Source's attributes the plugin makes during its call check the turn in
   * the database. False is the code as it is: declareAttributes and archiveAttribute write at once.
   */
  const GUARDED_ATTRIBUTES: bool
  /** How many containers may die in one execution: few, so that random traces reach long runs. */
  const MAX_CRASHES: int

  // ---- State ----------------------------------------------------------------------------------

  /** A row of `source_run_turn`; `held` false means no row. */
  type Turn = { held: bool, holder: str, expiresAt: int }

  /**
   * Where a run of a Source in one process is, following the code: Waiting (a push asking for the
   * turn), InTurn (turn taken, Source not yet read), Called (Source read, plugin called), Answered
   * (the plugin answered), Recording (changed secrets stored, the recording's transaction to come),
   * Done (written or rolled back, turn not yet ended).
   */
  type Phase = Idle | Waiting | InTurn | Called | Answered | Recording | Done

  /** The action that fired last, for the witnesses. */
  type Did =
    | DidInit | DidTick | DidStart | DidWait | DidSkip | DidAskAgain | DidGiveUp | DidRead | DidDeclare | DidDeclareSkipped | DidRenew
    | DidRenewLost | DidAnswer | DidRecordFailed | DidStoreSecrets | DidRecord | DidRollBack | DidEnd
    | DidCrash

  /** A run of a Source in one process. */
  type Run = {
    phase: Phase,
    push: bool,
    waitedSince: int,
    lost: bool,
    readCursor: int,
    readSecrets: int,
    readAttributes: int,
    ok: bool,
    secretsChanged: bool,
    epoch: int,
  }

  /**
   * Ghost state, not in the database: which action fired last (for the witnesses), how often each
   * Source's turn was taken (each taking starts a new turn), the turn of each Source's last
   * recorded run, and whether a run recorded after a run of the same or a later turn.
   */
  type Ghost = { lastAction: Did, taken: str -> int, recorded: str -> int, doubleRecord: bool }

  var now: int
  var turn: str -> Turn
  /** Version of each Source's Sync Cursor: bumped by every recorded run. */
  var cursor: str -> int
  /** Version of each Source's secret references: bumped by every write of changed secrets. */
  var secrets: str -> int
  /** Version of each Source's attributes: bumped by every declaration or archiving. */
  var attributes: str -> int
  var runs: (str, str) -> Run
  var alive: str -> bool
  /** Ghost: a write of a run that did not hold a valid turn when it was made. */
  var writeWithoutTurn: bool
  /** Ghost: a write based on a read another run's write had since replaced (a lost update). */
  var staleWrite: bool
  var ghost: Ghost

  // ---- Helpers --------------------------------------------------------------------------------

  val idleRun: Run = { phase: Idle, push: false, waitedSince: 0, lost: false, readCursor: 0, readSecrets: 0, readAttributes: 0, ok: true, secretsChanged: false, epoch: 0 }
  val noTurn: Turn = { held: false, holder: "", expiresAt: 0 }

  /** Whether `p` holds `s`'s turn unexpired, as `expires_at > now()` in the code. */
  def holds(p: str, s: str): bool = turn.get(s).held and turn.get(s).holder == p and turn.get(s).expiresAt > now

  /**
   * Whether `s`'s turn can be taken: no row, or one with `expires_at < now()`. As in the code
   * (`expires_at < now()` to take, `> now()` to hold), a turn at `expires_at = now()` is neither held
   * nor takeable: the clock must move on once more. Harmless, as it only delays a takeover.
   */
  def takeable(s: str): bool = not(turn.get(s).held) or turn.get(s).expiresAt < now

  action setRun(p: str, s: str, r: Run): bool = runs' = runs.set((p, s), r)

  /** Notes the action that fired. */
  action did(name: Did): bool = ghost' = { ...ghost, lastAction: name }

  /** Takes `s`'s turn for `p`'s run `r` in phase inTurn: a new turn. */
  action takeTurn(p: str, s: str, r: Run, name: Did): bool = {
    val epoch = ghost.taken.get(s) + 1
    all {
      turn' = turn.set(s, { held: true, holder: p, expiresAt: now + LASTS }),
      setRun(p, s, { ...r, phase: InTurn, epoch: epoch }),
      ghost' = { ...ghost, lastAction: name, taken: ghost.taken.set(s, epoch) },
    }
  }

  /** Whether a live push of `p` for `s` waits for the turn. */
  def pushWaits(p: str, s: str): bool = alive.get(p) and runs.get((p, s)).phase == Waiting

  /** Notes a write by `p` for `s`, based on `basis` of a value now at `current`. */
  action noteWrite(p: str, s: str, basis: int, current: int): bool = all {
    writeWithoutTurn' = (writeWithoutTurn or not(holds(p, s))),
    staleWrite' = (staleWrite or basis != current),
  }

  // ---- Actions --------------------------------------------------------------------------------

  action init = all {
    now' = 0,
    turn' = SOURCES.mapBy(_ => noTurn),
    cursor' = SOURCES.mapBy(_ => 0),
    secrets' = SOURCES.mapBy(_ => 0),
    attributes' = SOURCES.mapBy(_ => 0),
    runs' = tuples(PROCESSES, SOURCES).mapBy(_ => idleRun),
    alive' = PROCESSES.mapBy(_ => true),
    writeWithoutTurn' = false,
    staleWrite' = false,
    ghost' = { lastAction: DidInit, taken: SOURCES.mapBy(_ => 0), recorded: SOURCES.mapBy(_ => 0), doubleRecord: false },
  }

  /**
   * The database's clock moves on. A waiting push asks every 50 ms, far more often than a tick, so
   * the clock does not pass its deadline before it asked once more: it gets the turn or gives up.
   */
  action tick = all {
    now < MAX_TIME,
    tuples(PROCESSES, SOURCES).forall(ps =>
      not(pushWaits(ps._1, ps._2)) or now + 1 - runs.get(ps).waitedSince <= WAITS_AT_MOST),
    did(DidTick),
    now' = now + 1,
   
    turn' = turn, cursor' = cursor, secrets' = secrets, attributes' = attributes, runs' = runs, alive' = alive,
    writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
  }

  /** Unchanged besides the clock, the turns and the runs. */
  action keepData = all {
    now' = now, cursor' = cursor, secrets' = secrets, attributes' = attributes, alive' = alive,
    writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
  }

  /** A poll asks once for the turn (due work); a push starts asking and keeps asking. */
  action start(p: str, s: str, push: bool): bool = all {
    alive.get(p), runs.get((p, s)).phase == Idle,
    if (takeable(s)) takeTurn(p, s, { ...idleRun, push: push }, DidStart)
    else if (push) all {
      turn' = turn,
      setRun(p, s, { ...idleRun, phase: Waiting, push: true, waitedSince: now }),
      did(DidWait),
    } else all {
      // A poll leaves a Source another process runs to the next round.
      turn' = turn, runs' = runs, did(DidSkip),
    },
    keepData,
  }

  /** A waiting push asks again (every 50 ms), or gives up and fails temporarily. */
  action askAgain(p: str, s: str): bool = all {
    alive.get(p), runs.get((p, s)).phase == Waiting,
    // As in the code: ask first, then give up if no turn and the time is over.
    if (takeable(s)) takeTurn(p, s, runs.get((p, s)), DidAskAgain)
    else if (now - runs.get((p, s)).waitedSince >= WAITS_AT_MOST) all {
      turn' = turn, setRun(p, s, idleRun), did(DidGiveUp),
    } else all {
      turn' = turn, runs' = runs, did(DidAskAgain),
    },
    now' = now, cursor' = cursor, secrets' = secrets, attributes' = attributes, alive' = alive,
    writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
  }

  /** The run reads its Source afresh (cursor and secrets) and calls the plugin. */
  action read(p: str, s: str): bool = all {
    alive.get(p), runs.get((p, s)).phase == InTurn,
    setRun(p, s, { ...runs.get((p, s)), phase: Called, readCursor: cursor.get(s), readSecrets: secrets.get(s), readAttributes: attributes.get(s) }),
    turn' = turn, keepData, did(DidRead),
  }

  /**
   * The plugin declares or archives an attribute of the Source during its call, perhaps several
   * times. Its write is based on what the run last saw of the attributes; another run's write in
   * between makes it stale. Guarded, it is not made without the turn.
   */
  action declare(p: str, s: str): bool = {
    val r = runs.get((p, s))
    all {
      alive.get(p), r.phase == Called,
      turn' = turn, now' = now, cursor' = cursor, secrets' = secrets, alive' = alive,
      if (GUARDED_ATTRIBUTES and not(holds(p, s))) all {
        attributes' = attributes, runs' = runs,
        writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite, did(DidDeclareSkipped),
      } else all {
        attributes' = attributes.set(s, attributes.get(s) + 1),
        setRun(p, s, { ...r, readAttributes: attributes.get(s) + 1 }),
        noteWrite(p, s, r.readAttributes, attributes.get(s)),
        did(DidDeclare),
      },
    }
  }

  /** A renewal: extends the turn if still held unexpired, else marks the run lost. May run late or never. */
  action renew(p: str, s: str): bool = all {
    alive.get(p), Set(InTurn, Called, Answered, Recording).contains(runs.get((p, s)).phase),
    if (holds(p, s)) all {
      turn' = turn.set(s, { ...turn.get(s), expiresAt: now + LASTS }), runs' = runs, did(DidRenew),
    } else all {
      turn' = turn, setRun(p, s, { ...runs.get((p, s)), lost: true }), did(DidRenewLost),
    },
    keepData,
  }

  /** The plugin answers: a success or a failure, with changed secrets or without. */
  action answer(p: str, s: str, ok: bool, changed: bool): bool = all {
    alive.get(p), runs.get((p, s)).phase == Called,
    setRun(p, s, { ...runs.get((p, s)), phase: Answered, ok: ok, secretsChanged: ok and changed }),
    turn' = turn, keepData, did(DidAnswer),
  }

  /** A failed run: `recordFailedRun`, unless the run knows it is lost. */
  action recordFailed(p: str, s: str): bool = {
    val r = runs.get((p, s))
    all {
      alive.get(p), r.phase == Answered, not(r.ok),
      setRun(p, s, { ...r, phase: Done }),
      turn' = turn,
      now' = now, cursor' = cursor, secrets' = secrets, attributes' = attributes, alive' = alive,
      staleWrite' = staleWrite, did(DidRecordFailed),
      if (r.lost or (GUARDED_WRITES and not(holds(p, s)))) writeWithoutTurn' = writeWithoutTurn
      else writeWithoutTurn' = (writeWithoutTurn or not(holds(p, s))),
    }
  }

  /**
   * A successful run. First its changed secrets (`replaceSecrets`), then the transaction that locks
   * the turn's row and writes the Source Records and Sync Cursor, or rolls back as lost. Modelled
   * as two steps, as they are two transactions.
   */
  action storeSecrets(p: str, s: str): bool = {
    val r = runs.get((p, s))
    val skipped = r.lost or (GUARDED_WRITES and not(holds(p, s)))
    all {
      alive.get(p), r.phase == Answered, r.ok,
      if (skipped) setRun(p, s, { ...r, phase: Done })
      else setRun(p, s, { ...r, phase: Recording }),
      turn' = turn, did(DidStoreSecrets),
      now' = now, cursor' = cursor, alive' = alive, attributes' = attributes,
      if (skipped or not(r.secretsChanged)) all {
        secrets' = secrets, writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
      } else all {
        secrets' = secrets.set(s, secrets.get(s) + 1),
        noteWrite(p, s, r.readSecrets, secrets.get(s)),
      },
    }
  }

  /** `recordRun`: locks the turn's row FOR UPDATE; writes only while held unexpired. */
  action record(p: str, s: str): bool = {
    val r = runs.get((p, s))
    all {
      alive.get(p), r.phase == Recording,
      setRun(p, s, { ...r, phase: Done }),
      turn' = turn,
      now' = now, secrets' = secrets, attributes' = attributes, alive' = alive,
      if (holds(p, s)) all {
        cursor' = cursor.set(s, cursor.get(s) + 1),
        noteWrite(p, s, r.readCursor, cursor.get(s)),
        ghost' = { ...ghost, lastAction: DidRecord, recorded: ghost.recorded.set(s, r.epoch),
                   doubleRecord: ghost.doubleRecord or r.epoch <= ghost.recorded.get(s) },
      } else all {
        cursor' = cursor, writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
        did(DidRollBack),
      },
    }
  }

  /** The run ends its turn: deletes the row if it still holds it, by holder only. */
  action end(p: str, s: str): bool = all {
    alive.get(p), runs.get((p, s)).phase == Done,
    turn' = if (turn.get(s).held and turn.get(s).holder == p) turn.set(s, noTurn) else turn,
    setRun(p, s, idleRun),
    keepData, did(DidEnd),
  }

  /** A container dies: its runs stop where they are and it renews nothing. Its turns stay until they expire. */
  action crash(p: str): bool = all {
    alive.get(p), PROCESSES.filter(q => not(alive.get(q))).size() < MAX_CRASHES,
    alive' = alive.set(p, false),
    runs' = runs,
    turn' = turn, now' = now, cursor' = cursor, secrets' = secrets, attributes' = attributes,
    writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
    did(DidCrash),
  }

  action step = any {
    tick,
    nondet p = PROCESSES.oneOf()
    nondet s = SOURCES.oneOf()
    nondet push = Set(true, false).oneOf()
    nondet ok = Set(true, false).oneOf()
    nondet changed = Set(true, false).oneOf()
    any {
      start(p, s, push),
      askAgain(p, s),
      read(p, s),
      declare(p, s),
      renew(p, s),
      answer(p, s, ok, changed),
      recordFailed(p, s),
      storeSecrets(p, s),
      record(p, s),
      end(p, s),
      crash(p),
    },
  }

  // ---- Properties -----------------------------------------------------------------------------

  /** A run writes nothing unless it holds its Source's turn unexpired. */
  val noWriteWithoutTurn: bool = not(writeWithoutTurn)

  /** No run records from a read another run's write has since replaced (Sync Cursor, secrets). */
  val noStaleWrite: bool = not(staleWrite)

  /** At most one process holds a Source's turn unexpired. */
  // A turn has one holder by its row's shape (one `holder` column, the primary key on the Source),
  // so "at most one process holds a turn" holds by construction and is not checked. What the turn
  // must exclude is checked instead: `noWriteWithoutTurn`, `noStaleWrite` and `noDoubleRecord`.
  //
  // Liveness (a dead holder's turn is taken once expired) is not an invariant: the scenario
  // `deadTurnsAreTaken` and the witness `deadTurnTaken` show it happens; a `temporal` property with
  // fairness for `start` and `askAgain` would show it always does.

  /** Two runs of one Source never both record: each recording is of a later turn than the last. */
  val noDoubleRecord: bool = not(ghost.doubleRecord)

  /** A pushed payload gets the turn or fails temporarily within WAITS_AT_MOST (two minutes). */
  val pushGetsTurnOrFails: bool = tuples(PROCESSES, SOURCES).forall(ps =>
    not(pushWaits(ps._1, ps._2)) or now - runs.get(ps).waitedSince <= WAITS_AT_MOST)

  /** What Apalache checks exhaustively: `pushGetsTurnOrFails` follows from `tick`'s guard and costs it most. */
  val turnSafety: bool = noWriteWithoutTurn and noStaleWrite and noDoubleRecord

  val safety: bool = turnSafety and pushGetsTurnOrFails

  // ---- Witnesses: each action fires, and the states the properties speak of are reached -------

  val firesStart: bool = ghost.lastAction == DidStart
  val firesWait: bool = ghost.lastAction == DidWait
  val firesSkip: bool = ghost.lastAction == DidSkip
  val firesAskAgain: bool = ghost.lastAction == DidAskAgain
  val firesGiveUp: bool = ghost.lastAction == DidGiveUp
  val firesRead: bool = ghost.lastAction == DidRead
  val firesDeclare: bool = ghost.lastAction == DidDeclare
  val firesDeclareSkipped: bool = ghost.lastAction == DidDeclareSkipped
  val firesRenew: bool = ghost.lastAction == DidRenew
  val firesRenewLost: bool = ghost.lastAction == DidRenewLost
  val firesAnswer: bool = ghost.lastAction == DidAnswer
  val firesRecordFailed: bool = ghost.lastAction == DidRecordFailed
  val firesStoreSecrets: bool = ghost.lastAction == DidStoreSecrets
  val firesRecord: bool = ghost.lastAction == DidRecord
  val firesRollBack: bool = ghost.lastAction == DidRollBack
  val firesEnd: bool = ghost.lastAction == DidEnd
  val firesCrash: bool = ghost.lastAction == DidCrash
  /** A Source recorded by two turns. */
  val recordedTwice: bool = SOURCES.exists(s => cursor.get(s) >= 2)
  /** A dead holder's turn taken over by another container. */
  val deadTurnTaken: bool = SOURCES.exists(s =>
    ghost.taken.get(s) >= 2 and PROCESSES.exists(p => not(alive.get(p))) and turn.get(s).held and alive.get(turn.get(s).holder))

  // ---- Scenarios ------------------------------------------------------------------------------

  /** A container dies in a run; once its turn expired, another container takes it. */
  run deadTurnsAreTaken =
    init
      .then(start("p1", "s1", false))
      .then(crash("p1"))
      .then((LASTS + 1).reps(_ => tick))
      .then(start("p2", "s1", false))
      .expect(holds("p2", "s1"))

  /** Two runs of one Source, one after the other, both record: each a later turn than the last. */
  run twoRunsRecordInTurn =
    init
      .then(start("p1", "s1", false)).then(read("p1", "s1")).then(answer("p1", "s1", true, false))
      .then(storeSecrets("p1", "s1")).then(record("p1", "s1")).then(end("p1", "s1"))
      .then(start("p2", "s1", true)).then(read("p2", "s1")).then(answer("p2", "s1", true, false))
      .then(storeSecrets("p2", "s1")).then(record("p2", "s1"))
      .expect(cursor.get("s1") == 2 and ghost.recorded.get("s1") == 2 and noDoubleRecord)

  /**
   * A push waits on a dead holder's turn until its deadline, which the clock cannot pass; asking then,
   * it gets the turn (expired by now) or gives up.
   */
  run pushGetsTurnOrGivesUp =
    init
      .then(start("p1", "s1", false)).then(crash("p1"))
      .then(start("p2", "s1", true))
      .then(WAITS_AT_MOST.reps(_ => tick))
      .expect(now - runs.get(("p2", "s1")).waitedSince == WAITS_AT_MOST and pushGetsTurnOrFails)
      .then(askAgain("p2", "s1"))
      .expect(runs.get(("p2", "s1")).phase != Waiting)

  /**
   * A run stalls in its plugin's call past its turn's expiry; another container takes the turn and
   * its plugin declares the attributes; then the stale run's plugin declares (or archives) its own,
   * replacing them without the turn.
   */
  run staleRunReplacesAttributes =
    init
      .then(start("p1", "s1", true)).then(read("p1", "s1"))
      .then((LASTS + 1).reps(_ => tick))
      .then(start("p2", "s1", true)).then(read("p2", "s1")).then(declare("p2", "s1"))
      .then(declare("p1", "s1"))

  /**
   * The counterexample: p1's run stalls past its turn's expiry before any renewal noticed the loss;
   * p2 takes the turn, refreshes the secrets and records; then p1, still believing it holds the
   * turn, stores the secrets its plugin answered, replacing p2's newer ones.
   */
  run staleRunReplacesSecrets =
    init
      .then(start("p1", "s1", true))
      .then(read("p1", "s1"))
      .then(answer("p1", "s1", true, true))
      .then((LASTS + 1).reps(_ => tick))
      .then(start("p2", "s1", true))
      .then(read("p2", "s1"))
      .then(answer("p2", "s1", true, true))
      .then(storeSecrets("p2", "s1"))
      .then(record("p2", "s1"))
      .then(end("p2", "s1"))
      .then(storeSecrets("p1", "s1"))
}

/** The model as checked: three containers, two Sources. */
module checked {
  import sourceTurn(
    PROCESSES = Set("p1", "p2", "p3"),
    SOURCES = Set("s1", "s2"),
    LASTS = 3,
    WAITS_AT_MOST = 6,
    MAX_TIME = 8,
    GUARDED_WRITES = true,
    GUARDED_ATTRIBUTES = true,
    MAX_CRASHES = 1,
  ).*

  run deadTurnsAreTakenTest = deadTurnsAreTaken
  run twoRunsRecordInTurnTest = twoRunsRecordInTurn
  run pushGetsTurnOrGivesUpTest = pushGetsTurnOrGivesUp
  run staleRunIsSkippedTest = staleRunReplacesSecrets.expect(safety)
  run staleAttributesAreSkippedTest = staleRunReplacesAttributes.expect(safety)
}

/** The code as it was before this spec, kept to show the counterexample. */
module unguarded {
  import sourceTurn(
    PROCESSES = Set("p1", "p2"),
    SOURCES = Set("s1"),
    LASTS = 3,
    WAITS_AT_MOST = 6,
    MAX_TIME = 8,
    GUARDED_WRITES = false,
    GUARDED_ATTRIBUTES = false,
    MAX_CRASHES = 2,
  ).*

  run staleRunReplacesSecretsTest = staleRunReplacesSecrets.expect(writeWithoutTurn and staleWrite)
  run staleRunReplacesAttributesTest = staleRunReplacesAttributes.expect(writeWithoutTurn and staleWrite)
}

/** The model Apalache checks exhaustively to a depth: the turns of Sources are independent, so one Source. */
module exhaustive {
  import sourceTurn(
    PROCESSES = Set("p1", "p2"),
    SOURCES = Set("s1"),
    LASTS = 3,
    WAITS_AT_MOST = 6,
    MAX_TIME = 8,
    GUARDED_WRITES = true,
    GUARDED_ATTRIBUTES = true,
    MAX_CRASHES = 2,
  ).*
}

/**
 * The code as it is: changed secrets and failed runs check the turn, the attributes do not. Kept to
 * show the attributes' counterexample until they do (then remove it with `attributesUnguarded` in check.sh).
 */
module attributesUnguarded {
  import sourceTurn(
    PROCESSES = Set("p1", "p2"),
    SOURCES = Set("s1"),
    LASTS = 3,
    WAITS_AT_MOST = 6,
    MAX_TIME = 8,
    GUARDED_WRITES = true,
    GUARDED_ATTRIBUTES = false,
    MAX_CRASHES = 2,
  ).*

  run staleRunReplacesAttributesTest = staleRunReplacesAttributes.expect(writeWithoutTurn and staleWrite)
  run secretsStillGuardedTest = staleRunReplacesSecrets.expect(safety)
}
