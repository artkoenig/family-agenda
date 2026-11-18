// Runs of one Source take turns, kept in the Family's database, and due work asks for them (ADR-0008).
//
// Each action is one statement or one transaction of the core, so that the checker interleaves
// them as the database may: taking the turn (an upsert that takes over an expired row), renewing
// it, reading the Source, the plugin's answer, the writes of a run, and ending the turn. Time is a
// counter the database's now() follows; containers may stall, die or lose a renewal at any point.
//
// Each container has callers that run due work or hand a pushed payload to a Source: the worker's
// schedule, a trigger, a push. A caller runs one Source at a time, as pollDue goes through the due
// Sources one after the other. Runs of one Source within a container queue in memory first, so
// that only one of them at a time asks the database; all runs of a container take turns under the
// container's one holder.
//
// Actions and the code they stand for (application: polling.ts; adapters: PostgresSourceRunTurns,
// PostgresSourceRepository, PostgresItemRepository.recordRun):
//   beginRound       pollDue: the clock read once, findDue lists the Sources due then
//   nextDue, endRound  pollDue going through the due Sources, one run after the other, then ending
//   push             receive: a pushed payload for a Source
//   queue, dequeue   run: the run waits for the previous run of its Source in this container
//                    (the `runs` map), then asks the database
//   (asking)         takeTurn: SourceRunTurns.take, once for a poll, repeatedly for a push
//   askAgain         a waiting push asking again, or giving up
//   read             sources.findById at the start of the run; a poll runs only if the Source is
//                    still due (isDueNow), then the plugin's call
//   declare          the plugin declaring or archiving the Source's attributes during its call:
//                    SourceRepository.declareAttributesInTurn, archiveAttributeInTurn
//   renew            the renewal interval: SourceRunTurns.renew, setting `lost` when it fails
//   answer           the plugin's answer: ok or a failure, with changed secrets or without
//   recordFailed     SourceRepository.recordFailedRunInTurn, setting last_run_at
//   storeSecrets     storeChangedSecrets: SourceRepository.replaceSecretsInTurn
//   record           ItemRepository.recordRun, locking the turn's row FOR UPDATE, setting last_run_at
//   end              SourceRunTurns.end
//   crash            a container that dies; its turns stay until they expire
module sourceTurn {
  // ---- Parameters -----------------------------------------------------------------------------

  /** The api containers of one Family. */
  const PROCESSES: Set[str]
  /** What starts runs in one container at once: the schedule, a trigger, a push. */
  const CALLERS: Set[str]
  /** The Family's Sources. */
  const SOURCES: Set[str]
  /** How long a turn lasts unrenewed, in ticks of the database's clock. */
  const LASTS: int
  /** How long a pushed payload asks for the turn before it fails temporarily. */
  const WAITS_AT_MOST: int
  /** A Source's polling interval: it is due again this long after its last run started. */
  const INTERVAL: int
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
   * the database, as declareAttributesInTurn and archiveAttributeInTurn do. False is the code as it
   * was before: declareAttributes and archiveAttribute wrote at once.
   */
  const GUARDED_ATTRIBUTES: bool
  /** Whether a poll that got the turn runs only if its Source, read afresh, is still due (isDueNow). */
  const FRESH_DUE_CHECK: bool
  /** Whether runs of one Source in one container queue in memory before they ask the database. */
  const IN_MEMORY_QUEUE: bool
  /**
   * Whether live containers keep time, for the liveness bound: the clock does not move on while a
   * live container owes a step that takes no time (renewing a turn before it expires, its schedule
   * starting due work, a run going on past its plugin's call), nor while a plugin's call has lasted
   * CALL_TIMEOUT. False lets a container stall anywhere, as for safety.
   */
  const TIMELY: bool
  /** How long a plugin's call may last when TIMELY: its timeout. */
  const CALL_TIMEOUT: int
  /** How many containers may die in one execution: few, so that random traces reach long runs. */
  const MAX_CRASHES: int

  // ---- State ----------------------------------------------------------------------------------

  /** A row of `source_run_turn`; `held` false means no row. */
  type Turn = { held: bool, holder: str, expiresAt: int }

  /**
   * Where a caller's run is, following the code: Queued (behind another run of its Source in this
   * container), Waiting (a push asking for the turn), InTurn (turn taken, Source not yet read),
   * Called (Source read, plugin called), Answered (the plugin answered), Recording (changed secrets
   * stored, the recording's transaction to come), Done (written, rolled back or not run, turn not
   * yet ended).
   */
  type Phase = Idle | Queued | Waiting | InTurn | Called | Answered | Recording | Done

  /** The action that fired last, for the witnesses. */
  type Did =
    | DidInit | DidTick | DidBeginRound | DidEndRound | DidQueue | DidDequeue | DidStart | DidWait | DidSkip | DidAskAgain | DidGiveUp
    | DidRead | DidNoLongerDue | DidDeclare | DidDeclareSkipped | DidRenew | DidRenewLost | DidAnswer | DidRecordFailed
    | DidStoreSecrets | DidRecord | DidRollBack | DidEnd | DidCrash

  /**
   * A caller's run of a Source. `dueAt` is the clock its round read, which a poll checks the Source
   * against; `startedAt` the clock when it read the Source, which it records as its last run.
   */
  type Run = {
    phase: Phase,
    source: str,
    push: bool,
    dueAt: int,
    waitedSince: int,
    startedAt: int,
    lost: bool,
    readCursor: int,
    readSecrets: int,
    readAttributes: int,
    ok: bool,
    secretsChanged: bool,
    epoch: int,
  }

  /** A caller's due work: the clock it read and the due Sources it has yet to run. */
  type Round = { active: bool, at: int, pending: Set[str] }

  /**
   * Ghost state, not in the database: which action fired last (for the witnesses), how often each
   * Source's turn was taken (each taking starts a new turn), the turn of each Source's last
   * recorded run, whether a run recorded after a run of the same or a later turn, when each
   * Source's last recorded poll started, and whether a poll recorded less than INTERVAL after it.
   */
  type Ghost = {
    lastAction: Did,
    taken: str -> int,
    recorded: str -> int,
    doubleRecord: bool,
    lastPolled: str -> int,
    polledTwice: bool,
  }

  var now: int
  var turn: str -> Turn
  /** Version of each Source's Sync Cursor: bumped by every recorded run. */
  var cursor: str -> int
  /** Version of each Source's secret references: bumped by every write of changed secrets. */
  var secrets: str -> int
  /** Version of each Source's attributes: bumped by every declaration or archiving. */
  var attributes: str -> int
  /** `last_run_at` of each Source: when its last recorded run, failed or not, started. */
  var lastRun: str -> int
  /** Each caller's run, keyed by container and caller. */
  var runs: (str, str) -> Run
  /** Each caller's due work, keyed by container and caller. */
  var rounds: (str, str) -> Round
  var alive: str -> bool
  /** Ghost: a write of a run that did not hold its own turn unexpired when it was made. */
  var writeWithoutTurn: bool
  /** Ghost: a write based on a read another run's write had since replaced (a lost update). */
  var staleWrite: bool
  var ghost: Ghost

  // ---- Functional logic -----------------------------------------------------------------------

  /** Whether a Source last run at `last` is due at `at`, as isDue in polling.ts. */
  pure def isDue(last: int, at: int, interval: int): bool = at - last >= interval

  /** The Sources due at `at`, as findDue. */
  pure def dueAt(sources: Set[str], last: str -> int, at: int, interval: int): Set[str] =
    sources.filter(s => isDue(last.get(s), at, interval))

  /** Whether `r` is a run of `s` past the queue: asking the database, or in its turn. */
  pure def asksFor(r: Run, s: str): bool = r.source == s and not(Set(Idle, Queued).contains(r.phase))

  /** Whether `r` is a run in or after its plugin's call that must go on without time passing. */
  pure def owesStep(r: Run): bool = Set(InTurn, Answered, Recording, Done).contains(r.phase)

  // ---- Helpers --------------------------------------------------------------------------------

  val idleRun: Run = {
    phase: Idle, source: "", push: false, dueAt: 0, waitedSince: 0, startedAt: 0, lost: false,
    readCursor: 0, readSecrets: 0, readAttributes: 0, ok: true, secretsChanged: false, epoch: 0,
  }
  val noTurn: Turn = { held: false, holder: "", expiresAt: 0 }
  val noRound: Round = { active: false, at: 0, pending: Set() }

  /** Whether `p` holds `s`'s turn unexpired, as `expires_at > now()` in the code. */
  def holds(p: str, s: str): bool = turn.get(s).held and turn.get(s).holder == p and turn.get(s).expiresAt > now

  /**
   * Whether `r` of `p` holds its own turn: `p` holds the Source's turn, and it is the turn `r`
   * took, not one another run of `p` took since. The code can only check the first.
   */
  def ownTurn(p: str, r: Run): bool = holds(p, r.source) and ghost.taken.get(r.source) == r.epoch

  /**
   * Whether `s`'s turn can be taken: no row, or one with `expires_at < now()`. As in the code
   * (`expires_at < now()` to take, `> now()` to hold), a turn at `expires_at = now()` is neither held
   * nor takeable: the clock must move on once more. Harmless, as it only delays a takeover.
   */
  def takeable(s: str): bool = not(turn.get(s).held) or turn.get(s).expiresAt < now

  /** Whether another caller of `p` than `c` runs `s` past the queue. */
  def otherAsks(p: str, c: str, s: str): bool = CALLERS.exclude(Set(c)).exists(d => runs.get((p, d)).asksFor(s))

  /** Whether caller `c` of `p` is free: no run, no due work. */
  def free(p: str, c: str): bool = runs.get((p, c)).phase == Idle and not(rounds.get((p, c)).active)

  /** Whether a live push of `p`'s caller `c` waits for the turn. */
  def pushWaits(p: str, c: str): bool = alive.get(p) and runs.get((p, c)).phase == Waiting

  action setRun(p: str, c: str, r: Run): bool = runs' = runs.set((p, c), r)

  /** Notes the action that fired. */
  action did(name: Did): bool = ghost' = { ...ghost, lastAction: name }

  /** Takes the turn of `r`'s Source for `p`'s caller `c`, in phase InTurn: a new turn. */
  action takeTurn(p: str, c: str, r: Run, name: Did): bool = {
    val epoch = ghost.taken.get(r.source) + 1
    all {
      turn' = turn.set(r.source, { held: true, holder: p, expiresAt: now + LASTS }),
      setRun(p, c, { ...r, phase: InTurn, epoch: epoch }),
      ghost' = { ...ghost, lastAction: name, taken: ghost.taken.set(r.source, epoch) },
    }
  }

  /**
   * Run `r` asks the database for its Source's turn: takes it, or, as a push, starts waiting for
   * it; a poll leaves a Source another container runs to the next round.
   */
  action ask(p: str, c: str, r: Run, name: Did): bool =
    if (takeable(r.source)) takeTurn(p, c, r, name)
    else if (r.push) all {
      turn' = turn, setRun(p, c, { ...r, phase: Waiting, waitedSince: now }), did(DidWait),
    } else all {
      turn' = turn, setRun(p, c, idleRun), did(DidSkip),
    }

  /** Run `r` of `p`'s caller `c` begins: it queues behind a run of its Source in this container, or asks. */
  action enter(p: str, c: str, r: Run): bool =
    if (IN_MEMORY_QUEUE and CALLERS.exclude(Set(c)).exists(d => runs.get((p, d)).source == r.source and runs.get((p, d)).phase != Idle))
      all { turn' = turn, setRun(p, c, { ...r, phase: Queued }), did(DidQueue) }
    else ask(p, c, r, DidStart)

  /** Notes a write by run `r` of `p`, based on `basis` of a value now at `current`. */
  action noteWrite(p: str, r: Run, basis: int, current: int): bool = all {
    writeWithoutTurn' = (writeWithoutTurn or not(ownTurn(p, r))),
    staleWrite' = (staleWrite or basis != current),
  }

  /** The ghost of a recorded run `r` (records, or a failed run): notes a poll recorded too soon. */
  pure def polled(g: Ghost, r: Run): Ghost =
    if (r.push) g
    else { ...g, lastPolled: g.lastPolled.set(r.source, r.startedAt),
                 polledTwice: g.polledTwice or r.startedAt - g.lastPolled.get(r.source) < INTERVAL }

  // ---- Actions --------------------------------------------------------------------------------

  action init = all {
    now' = 0,
    turn' = SOURCES.mapBy(_ => noTurn),
    cursor' = SOURCES.mapBy(_ => 0),
    secrets' = SOURCES.mapBy(_ => 0),
    attributes' = SOURCES.mapBy(_ => 0),
    // Never run, so due at once.
    lastRun' = SOURCES.mapBy(_ => -INTERVAL),
    runs' = tuples(PROCESSES, CALLERS).mapBy(_ => idleRun),
    rounds' = tuples(PROCESSES, CALLERS).mapBy(_ => noRound),
    alive' = PROCESSES.mapBy(_ => true),
    writeWithoutTurn' = false,
    staleWrite' = false,
    ghost' = {
      lastAction: DidInit, taken: SOURCES.mapBy(_ => 0), recorded: SOURCES.mapBy(_ => 0), doubleRecord: false,
      lastPolled: SOURCES.mapBy(_ => -INTERVAL), polledTwice: false,
    },
  }

  /** Whether live container `p` owes a step before the clock moves on (TIMELY). */
  def owesTime(p: str): bool = alive.get(p) and or {
    // A run renews its turn before it expires.
    CALLERS.exists(c => runs.get((p, c)).phase != Idle and holds(p, runs.get((p, c)).source)
      and turn.get(runs.get((p, c)).source).expiresAt <= now + 1),
    // A run goes on past its plugin's call, and a call ends by its timeout.
    CALLERS.exists(c => owesStep(runs.get((p, c)))),
    CALLERS.exists(c => runs.get((p, c)).phase == Called and now + 1 - runs.get((p, c)).startedAt > CALL_TIMEOUT),
    // Due work goes on to its next Source.
    CALLERS.exists(c => rounds.get((p, c)).active and runs.get((p, c)).phase == Idle),
    // The schedule starts due work while a Source is due and this container runs none.
    dueAt(SOURCES, lastRun, now, INTERVAL) != Set() and not(CALLERS.exists(c => rounds.get((p, c)).active)),
  }

  /**
   * The database's clock moves on. A waiting push asks every 50 ms, far more often than a tick, so
   * the clock does not pass its deadline before it asked once more: it gets the turn or gives up.
   */
  action tick = all {
    now < MAX_TIME,
    tuples(PROCESSES, CALLERS).forall(pc =>
      not(pushWaits(pc._1, pc._2)) or now + 1 - runs.get(pc).waitedSince <= WAITS_AT_MOST),
    not(TIMELY) or PROCESSES.forall(p => not(owesTime(p))),
    did(DidTick),
    now' = now + 1,
    turn' = turn, cursor' = cursor, secrets' = secrets, attributes' = attributes, lastRun' = lastRun,
    runs' = runs, rounds' = rounds, alive' = alive,
    writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
  }

  /** Unchanged besides the clock, the turns, the runs and the ghost. */
  action keepData = all {
    now' = now, cursor' = cursor, secrets' = secrets, attributes' = attributes, lastRun' = lastRun,
    rounds' = rounds, alive' = alive, writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
  }

  /** Due work begins: reads the clock and lists the Sources due then; with none, it ends at once. */
  action beginRound(p: str, c: str): bool = {
    val due = dueAt(SOURCES, lastRun, now, INTERVAL)
    all {
      alive.get(p), free(p, c), due != Set(),
      rounds' = rounds.set((p, c), { active: true, at: now, pending: due }),
      did(DidBeginRound),
      now' = now, turn' = turn, cursor' = cursor, secrets' = secrets, attributes' = attributes, lastRun' = lastRun,
      runs' = runs, alive' = alive, writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
    }
  }

  /** Due work runs the next of its due Sources, after the run before it is over. */
  action nextDue(p: str, c: str, s: str): bool = {
    val round = rounds.get((p, c))
    all {
      alive.get(p), round.active, runs.get((p, c)).phase == Idle, round.pending.contains(s),
      rounds' = rounds.set((p, c), { ...round, pending: round.pending.exclude(Set(s)) }),
      enter(p, c, { ...idleRun, source: s, push: false, dueAt: round.at }),
      now' = now, cursor' = cursor, secrets' = secrets, attributes' = attributes, lastRun' = lastRun,
      alive' = alive, writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
    }
  }

  /** Due work ends once it ran its due Sources. */
  action endRound(p: str, c: str): bool = {
    val round = rounds.get((p, c))
    all {
      alive.get(p), round.active, runs.get((p, c)).phase == Idle, round.pending == Set(),
      rounds' = rounds.set((p, c), noRound),
      did(DidEndRound),
      now' = now, turn' = turn, cursor' = cursor, secrets' = secrets, attributes' = attributes, lastRun' = lastRun,
      runs' = runs, alive' = alive, writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
    }
  }

  /** A payload pushed for `s`; it waits for the turn as long as it may. */
  action push(p: str, c: str, s: str): bool = all {
    alive.get(p), free(p, c),
    enter(p, c, { ...idleRun, source: s, push: true }),
    keepData,
  }

  /** A queued run asks the database once no other run of its Source in this container does. */
  action dequeue(p: str, c: str): bool = {
    val r = runs.get((p, c))
    all {
      alive.get(p), r.phase == Queued, not(otherAsks(p, c, r.source)),
      ask(p, c, r, DidDequeue),
      keepData,
    }
  }

  /** A waiting push asks again (every 50 ms), or gives up and fails temporarily. */
  action askAgain(p: str, c: str): bool = {
    val r = runs.get((p, c))
    all {
      alive.get(p), r.phase == Waiting,
      // As in the code: ask first, then give up if no turn and the time is over.
      if (takeable(r.source)) takeTurn(p, c, r, DidAskAgain)
      else if (now - r.waitedSince >= WAITS_AT_MOST) all {
        turn' = turn, setRun(p, c, idleRun), did(DidGiveUp),
      } else all {
        turn' = turn, runs' = runs, did(DidAskAgain),
      },
      keepData,
    }
  }

  /**
   * The run reads its Source afresh (cursor, secrets, attributes, last run) and calls the plugin;
   * a poll whose Source is no longer due, as another container polled it meanwhile, ends instead.
   */
  action read(p: str, c: str): bool = {
    val r = runs.get((p, c))
    val s = r.source
    all {
      alive.get(p), r.phase == InTurn,
      if (not(r.push) and FRESH_DUE_CHECK and not(isDue(lastRun.get(s), r.dueAt, INTERVAL)))
        all { setRun(p, c, { ...r, phase: Done }), did(DidNoLongerDue) }
      else all {
        setRun(p, c, { ...r, phase: Called, startedAt: now, readCursor: cursor.get(s), readSecrets: secrets.get(s), readAttributes: attributes.get(s) }),
        did(DidRead),
      },
      turn' = turn, keepData,
    }
  }

  /**
   * The plugin declares or archives an attribute of the Source during its call, perhaps several
   * times. Its write is based on what the run last saw of the attributes; another run's write in
   * between makes it stale. Guarded, it is not made without the turn.
   */
  action declare(p: str, c: str): bool = {
    val r = runs.get((p, c))
    val s = r.source
    all {
      alive.get(p), r.phase == Called,
      turn' = turn, now' = now, cursor' = cursor, secrets' = secrets, lastRun' = lastRun, rounds' = rounds, alive' = alive,
      if (GUARDED_ATTRIBUTES and not(holds(p, s))) all {
        attributes' = attributes, runs' = runs,
        writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite, did(DidDeclareSkipped),
      } else all {
        attributes' = attributes.set(s, attributes.get(s) + 1),
        setRun(p, c, { ...r, readAttributes: attributes.get(s) + 1 }),
        noteWrite(p, r, r.readAttributes, attributes.get(s)),
        did(DidDeclare),
      },
    }
  }

  /** A renewal: extends the turn if still held unexpired, else marks the run lost. May run late or never. */
  action renew(p: str, c: str): bool = {
    val r = runs.get((p, c))
    all {
      alive.get(p), Set(InTurn, Called, Answered, Recording).contains(r.phase),
      if (holds(p, r.source)) all {
        turn' = turn.set(r.source, { ...turn.get(r.source), expiresAt: now + LASTS }), runs' = runs, did(DidRenew),
      } else all {
        turn' = turn, setRun(p, c, { ...r, lost: true }), did(DidRenewLost),
      },
      keepData,
    }
  }

  /** The plugin answers: a success or a failure, with changed secrets or without. */
  action answer(p: str, c: str, ok: bool, changed: bool): bool = all {
    alive.get(p), runs.get((p, c)).phase == Called,
    setRun(p, c, { ...runs.get((p, c)), phase: Answered, ok: ok, secretsChanged: ok and changed }),
    turn' = turn, keepData, did(DidAnswer),
  }

  /** A failed run: `recordFailedRun`, setting the last run, unless the run knows it is lost. */
  action recordFailed(p: str, c: str): bool = {
    val r = runs.get((p, c))
    val s = r.source
    all {
      alive.get(p), r.phase == Answered, not(r.ok),
      setRun(p, c, { ...r, phase: Done }),
      turn' = turn,
      now' = now, cursor' = cursor, secrets' = secrets, attributes' = attributes, rounds' = rounds, alive' = alive,
      staleWrite' = staleWrite,
      if (r.lost or (GUARDED_WRITES and not(holds(p, s)))) all {
        lastRun' = lastRun, writeWithoutTurn' = writeWithoutTurn, did(DidRecordFailed),
      } else all {
        lastRun' = lastRun.set(s, r.startedAt),
        writeWithoutTurn' = (writeWithoutTurn or not(ownTurn(p, r))),
        ghost' = { ...polled(ghost, r), lastAction: DidRecordFailed },
      },
    }
  }

  /**
   * A successful run. First its changed secrets (`replaceSecrets`), then the transaction that locks
   * the turn's row and writes the Source Records and Sync Cursor, or rolls back as lost. Modelled
   * as two steps, as they are two transactions.
   */
  action storeSecrets(p: str, c: str): bool = {
    val r = runs.get((p, c))
    val s = r.source
    val skipped = r.lost or (GUARDED_WRITES and not(holds(p, s)))
    all {
      alive.get(p), r.phase == Answered, r.ok,
      if (skipped) setRun(p, c, { ...r, phase: Done })
      else setRun(p, c, { ...r, phase: Recording }),
      turn' = turn, did(DidStoreSecrets),
      now' = now, cursor' = cursor, attributes' = attributes, lastRun' = lastRun, rounds' = rounds, alive' = alive,
      if (skipped or not(r.secretsChanged)) all {
        secrets' = secrets, writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
      } else all {
        secrets' = secrets.set(s, secrets.get(s) + 1),
        noteWrite(p, r, r.readSecrets, secrets.get(s)),
      },
    }
  }

  /** `recordRun`: locks the turn's row FOR UPDATE; writes only while held unexpired. */
  action record(p: str, c: str): bool = {
    val r = runs.get((p, c))
    val s = r.source
    all {
      alive.get(p), r.phase == Recording,
      setRun(p, c, { ...r, phase: Done }),
      turn' = turn,
      now' = now, secrets' = secrets, attributes' = attributes, rounds' = rounds, alive' = alive,
      if (holds(p, s)) all {
        cursor' = cursor.set(s, cursor.get(s) + 1),
        lastRun' = lastRun.set(s, r.startedAt),
        noteWrite(p, r, r.readCursor, cursor.get(s)),
        ghost' = { ...polled(ghost, r), lastAction: DidRecord, recorded: ghost.recorded.set(s, r.epoch),
                   doubleRecord: ghost.doubleRecord or r.epoch <= ghost.recorded.get(s) },
      } else all {
        cursor' = cursor, lastRun' = lastRun, writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
        did(DidRollBack),
      },
    }
  }

  /** The run ends its turn: deletes the row if this container holds it, by holder only. */
  action end(p: str, c: str): bool = {
    val s = runs.get((p, c)).source
    all {
      alive.get(p), runs.get((p, c)).phase == Done,
      turn' = if (turn.get(s).held and turn.get(s).holder == p) turn.set(s, noTurn) else turn,
      setRun(p, c, idleRun),
      keepData, did(DidEnd),
    }
  }

  /** A container dies: its runs stop where they are and it renews nothing. Its turns stay until they expire. */
  action crash(p: str): bool = all {
    alive.get(p), PROCESSES.filter(q => not(alive.get(q))).size() < MAX_CRASHES,
    alive' = alive.set(p, false),
    runs' = runs, rounds' = rounds,
    turn' = turn, now' = now, cursor' = cursor, secrets' = secrets, attributes' = attributes, lastRun' = lastRun,
    writeWithoutTurn' = writeWithoutTurn, staleWrite' = staleWrite,
    did(DidCrash),
  }

  action step = any {
    tick,
    nondet p = PROCESSES.oneOf()
    nondet c = CALLERS.oneOf()
    nondet s = SOURCES.oneOf()
    nondet ok = Set(true, false).oneOf()
    nondet changed = Set(true, false).oneOf()
    any {
      beginRound(p, c),
      nextDue(p, c, s),
      endRound(p, c),
      push(p, c, s),
      dequeue(p, c),
      askAgain(p, c),
      read(p, c),
      declare(p, c),
      renew(p, c),
      answer(p, c, ok, changed),
      recordFailed(p, c),
      storeSecrets(p, c),
      record(p, c),
      end(p, c),
      crash(p),
    },
  }

  // ---- Properties -----------------------------------------------------------------------------

  /** A run writes nothing unless it holds its own turn of its Source unexpired. */
  val noWriteWithoutTurn: bool = not(writeWithoutTurn)

  /** No run records from a read another run's write has since replaced (Sync Cursor, secrets). */
  val noStaleWrite: bool = not(staleWrite)

  // A turn has one holder by its row's shape (one `holder` column, the primary key on the Source),
  // so "at most one process holds a turn" holds by construction and is not checked. What the turn
  // must exclude is checked instead: `noWriteWithoutTurn`, `noStaleWrite` and `noDoubleRecord`.

  /** Two runs of one Source never both record: each recording is of a later turn than the last. */
  val noDoubleRecord: bool = not(ghost.doubleRecord)

  /** A pushed payload gets the turn or fails temporarily within WAITS_AT_MOST (two minutes). */
  val pushGetsTurnOrFails: bool = tuples(PROCESSES, CALLERS).forall(pc =>
    not(pushWaits(pc._1, pc._2)) or now - runs.get(pc).waitedSince <= WAITS_AT_MOST)

  /**
   * Due work polls each due Source at most once per round, on however many containers it runs at
   * once: two recorded polls of a Source start at least INTERVAL apart.
   */
  val pollsOncePerRound: bool = not(ghost.polledTwice)

  /** Within a container, at most one run of a Source asks the database or holds its turn. */
  val oneAskerPerContainer: bool = tuples(PROCESSES, SOURCES).forall(ps =>
    CALLERS.filter(c => runs.get((ps._1, c)).asksFor(ps._2)).size() <= 1)

  /**
   * Liveness as a bound, for live containers that keep time (TIMELY, no crashes): every due Source
   * is polled within DUE_BOUND ticks of becoming due, however often due work skips it as another
   * container runs it. Its last run is then never older than INTERVAL + bound.
   */
  def dueSourcePolledWithin(bound: int): bool = SOURCES.forall(s => now - lastRun.get(s) <= INTERVAL + bound)

  /** What Apalache checks exhaustively: `pushGetsTurnOrFails` follows from `tick`'s guard and costs it most. */
  val turnSafety: bool = noWriteWithoutTurn and noStaleWrite and noDoubleRecord

  val dueSafety: bool = pollsOncePerRound and oneAskerPerContainer

  val safety: bool = turnSafety and pushGetsTurnOrFails and dueSafety

  // ---- Witnesses: each action fires, and the states the properties speak of are reached -------

  val firesBeginRound: bool = ghost.lastAction == DidBeginRound
  val firesEndRound: bool = ghost.lastAction == DidEndRound
  val firesQueue: bool = ghost.lastAction == DidQueue
  val firesStart: bool = ghost.lastAction == DidStart
  val firesWait: bool = ghost.lastAction == DidWait
  val firesSkip: bool = ghost.lastAction == DidSkip
  val firesAskAgain: bool = ghost.lastAction == DidAskAgain
  val firesGiveUp: bool = ghost.lastAction == DidGiveUp
  val firesRead: bool = ghost.lastAction == DidRead
  val firesNoLongerDue: bool = ghost.lastAction == DidNoLongerDue
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
  /** A queued run that takes the turn once the run before it in its container is over. */
  val firesDequeue: bool = ghost.lastAction == DidDequeue
  /** A Source recorded by two turns. */
  val recordedTwice: bool = SOURCES.exists(s => cursor.get(s) >= 2)
  /** A Source polled in two rounds. */
  val polledInTwoRounds: bool = SOURCES.exists(s => ghost.lastPolled.get(s) >= INTERVAL)
  /** A dead holder's turn taken over by another container. */
  val deadTurnTaken: bool = SOURCES.exists(s =>
    ghost.taken.get(s) >= 2 and PROCESSES.exists(p => not(alive.get(p))) and turn.get(s).held and alive.get(turn.get(s).holder))
}
