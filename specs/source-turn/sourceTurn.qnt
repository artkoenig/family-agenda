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

  // ---- State ----------------------------------------------------------------------------------

  /** A row of `source_run_turn`; `held` false means no row. */
  type Turn = { held: bool, holder: str, expiresAt: int }

  /**
   * A run of a Source in one process. `phase` follows the code: idle, waiting (a push asking for
   * the turn), inTurn (turn taken, Source not yet read), called (Source read, plugin called),
   * answered (the plugin answered), done (written, turn not yet ended).
   */
  type Run = {
    phase: str,
    push: bool,
    waitedSince: int,
    lost: bool,
    readCursor: int,
    readSecrets: int,
    ok: bool,
    secretsChanged: bool,
  }

  var now: int
  var turn: str -> Turn
  /** Version of each Source's Sync Cursor: bumped by every recorded run. */
  var cursor: str -> int
  /** Version of each Source's secret references: bumped by every write of changed secrets. */
  var secrets: str -> int
  var runs: (str, str) -> Run
  var alive: str -> bool
  /** Ghost: a write of a run that did not hold a valid turn when it was made. */
  var writeWithoutTurn: bool
  /** Ghost: a write based on a read another run's write had since replaced (a lost update). */
  var staleWrite: bool

  // ---- Helpers --------------------------------------------------------------------------------

  val idleRun: Run = { phase: "idle", push: false, waitedSince: 0, lost: false, readCursor: 0, readSecrets: 0, ok: true, secretsChanged: false }
  val noTurn: Turn = { held: false, holder: "", expiresAt: 0 }

  /** Whether `p` holds `s`'s turn unexpired, as `expires_at > now()` in the code. */
  def holds(p: str, s: str): bool = turn.get(s).held and turn.get(s).holder == p and turn.get(s).expiresAt > now

  /** Whether `s`'s turn can be taken: no row, or one with `expires_at < now()`. */
  def takeable(s: str): bool = not(turn.get(s).held) or turn.get(s).expiresAt < now

  action setRun(p: str, s: str, r: Run): bool = runs' = runs.set((p, s), r)

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
    runs' = tuples(PROCESSES, SOURCES).mapBy(_ => idleRun),
    alive' = PROCESSES.mapBy(_ => true),
    writeWithoutTurn' = false,
    staleWrite' = false,
  }

  /** The database's clock moves on. */
  action tick = all {
    now < MAX_TIME,
    now' = now + 1,
   
    turn' = turn, cursor' = cursor, secrets' = secrets, runs' = runs, alive' = alive,
    writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
  }

  /** Unchanged besides the clock, the turns and the runs. */
  action keepData = all {
    now' = now, cursor' = cursor, secrets' = secrets, alive' = alive,
    writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
  }

  /** A poll asks once for the turn (due work); a push starts asking and keeps asking. */
  action start(p: str, s: str, push: bool): bool = all {
    alive.get(p), runs.get((p, s)).phase == "idle",
    if (takeable(s)) all {
      turn' = turn.set(s, { held: true, holder: p, expiresAt: now + LASTS }),
      setRun(p, s, { ...idleRun, phase: "inTurn", push: push }),
    } else if (push) all {
      turn' = turn,
      setRun(p, s, { ...idleRun, phase: "waiting", push: true, waitedSince: now }),
    } else all {
      // A poll leaves a Source another process runs to the next round.
      turn' = turn, runs' = runs,
    },
    keepData,
  }

  /** A waiting push asks again (every 50 ms), or gives up and fails temporarily. */
  action askAgain(p: str, s: str): bool = all {
    alive.get(p), runs.get((p, s)).phase == "waiting",
    // As in the code: ask first, then give up if no turn and the time is over.
    if (takeable(s)) all {
      turn' = turn.set(s, { held: true, holder: p, expiresAt: now + LASTS }),
      setRun(p, s, { ...runs.get((p, s)), phase: "inTurn" }),
    } else if (now - runs.get((p, s)).waitedSince >= WAITS_AT_MOST) all {
      turn' = turn, setRun(p, s, idleRun),
    } else all {
      turn' = turn, runs' = runs,
    },
    now' = now, cursor' = cursor, secrets' = secrets, alive' = alive,
    writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
  }

  /** The run reads its Source afresh (cursor and secrets) and calls the plugin. */
  action read(p: str, s: str): bool = all {
    alive.get(p), runs.get((p, s)).phase == "inTurn",
    setRun(p, s, { ...runs.get((p, s)), phase: "called", readCursor: cursor.get(s), readSecrets: secrets.get(s) }),
    turn' = turn, keepData,
  }

  /** A renewal: extends the turn if still held unexpired, else marks the run lost. May run late or never. */
  action renew(p: str, s: str): bool = all {
    alive.get(p), Set("inTurn", "called", "answered").contains(runs.get((p, s)).phase),
    if (holds(p, s)) all {
      turn' = turn.set(s, { ...turn.get(s), expiresAt: now + LASTS }), runs' = runs,
    } else all {
      turn' = turn, setRun(p, s, { ...runs.get((p, s)), lost: true }),
    },
    keepData,
  }

  /** The plugin answers: a success or a failure, with changed secrets or without. */
  action answer(p: str, s: str, ok: bool, changed: bool): bool = all {
    alive.get(p), runs.get((p, s)).phase == "called",
    setRun(p, s, { ...runs.get((p, s)), phase: "answered", ok: ok, secretsChanged: ok and changed }),
    turn' = turn, keepData,
  }

  /** A failed run: `recordFailedRun`, unless the run knows it is lost. */
  action recordFailed(p: str, s: str): bool = {
    val r = runs.get((p, s))
    all {
      alive.get(p), r.phase == "answered", not(r.ok),
      setRun(p, s, { ...r, phase: "done" }),
      turn' = turn,
      now' = now, cursor' = cursor, secrets' = secrets, alive' = alive,
      staleWrite' = staleWrite,
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
      alive.get(p), r.phase == "answered", r.ok,
      if (skipped) setRun(p, s, { ...r, phase: "done" })
      else setRun(p, s, { ...r, phase: "recording" }),
      turn' = turn,
      now' = now, cursor' = cursor, alive' = alive,
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
      alive.get(p), r.phase == "recording",
      setRun(p, s, { ...r, phase: "done" }),
      turn' = turn,
      now' = now, secrets' = secrets, alive' = alive,
      if (holds(p, s)) all {
        cursor' = cursor.set(s, cursor.get(s) + 1),
        noteWrite(p, s, r.readCursor, cursor.get(s)),
      } else all {
        cursor' = cursor, writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
      },
    }
  }

  /** The run ends its turn: deletes the row if it still holds it, by holder only. */
  action end(p: str, s: str): bool = all {
    alive.get(p), runs.get((p, s)).phase == "done",
    turn' = if (turn.get(s).held and turn.get(s).holder == p) turn.set(s, noTurn) else turn,
    setRun(p, s, idleRun),
    keepData,
  }

  /** A container dies: its runs stop where they are and it renews nothing. Its turns stay until they expire. */
  action crash(p: str): bool = all {
    alive.get(p),
    alive' = alive.set(p, false),
    runs' = runs,
    turn' = turn, now' = now, cursor' = cursor, secrets' = secrets,
    writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
  }

  action step = any {
    tick,
    nondet p = oneOf(PROCESSES)
    nondet s = oneOf(SOURCES)
    nondet push = oneOf(Set(true, false))
    nondet ok = oneOf(Set(true, false))
    nondet changed = oneOf(Set(true, false))
    any {
      start(p, s, push),
      askAgain(p, s),
      read(p, s),
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
  val oneHolder: bool = SOURCES.forall(s => PROCESSES.filter(p => holds(p, s)).size() <= 1)

  /**
   * What liveness rests on: a turn whose holder died expires within LASTS of its last renewal,
   * after which `start` and `askAgain` take it (see `takeable`). `deadTurnsAreTaken` checks it.
   */
  val deadTurnsExpire: bool = SOURCES.forall(s =>
    (turn.get(s).held and not(alive.get(turn.get(s).holder))) implies turn.get(s).expiresAt <= now + LASTS)

  val safety: bool = noWriteWithoutTurn and noStaleWrite and oneHolder and deadTurnsExpire

  // ---- Scenarios ------------------------------------------------------------------------------

  /** A container dies in a run; once its turn expired, another container takes it. */
  run deadTurnsAreTaken =
    init
      .then(start("p1", "s1", false))
      .then(crash("p1"))
      .then((LASTS + 1).reps(_ => tick))
      .then(start("p2", "s1", false))
      .expect(holds("p2", "s1"))

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
  ).*

  run deadTurnsAreTakenTest = deadTurnsAreTaken
  run staleRunIsSkippedTest = staleRunReplacesSecrets.expect(safety)
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
  ).*

  run staleRunReplacesSecretsTest = staleRunReplacesSecrets.expect(writeWithoutTurn and staleWrite)
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
  ).*
}
