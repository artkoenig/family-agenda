// Extraction reads each message once, a second time when an Item fails a check (ADR-0005).
//
// Runs of due work read the messages that wait to be read, through the Family's LLM endpoint, and
// may overlap: the worker's schedule and a trigger each start one. Each action is one statement,
// one transaction or one call of the core, so that the checker interleaves them as the database
// and the endpoint may. A worker may crash at any point, and the endpoint may be down for a while.
//
// A message waits to be read while it has no `processed_at`, has its text, is not withdrawn and has
// not failed. A reading whose answer is invalid, or that times out, counts as a failed attempt of
// the message; after MAX_FAILURES of them the message has failed: no run reads it any more, until
// an Admin retries it. An unreachable endpoint or a refused key is not the message's failure: it
// counts against nothing and ends the run, since the rest would fail the same way.
//
// Actions and the code they stand for (application: extraction.ts; adapters:
// PostgresItemRepository):
//   take          extractPending: pendingMessages(batchSize), the oldest messages waiting
//   check         before each reading: isPendingMessage, skipping one another run read meanwhile
//   call          extractor.extract, the LLM endpoint's call (first or second reading)
//   answer        its answer: Items that all pass their checks, some failing, invalid output, a
//                 timeout, or the endpoint unreachable; failing checks the first time, it reads again
//   record        recordExtraction: processed_at and the Items in one transaction, only if pending
//   recordFailure recordExtractionFailure: the failed attempt, failing the message at MAX_FAILURES
//   end           the end of the run, once its batch is through or its endpoint failed
//   crash         a worker that dies, losing its run; what it wrote stays
//   retry         an Admin retrying a failed message: retryExtraction
module extraction {
  // ---- Parameters -----------------------------------------------------------------------------

  /** What runs due work at once: the worker's schedule, a trigger. */
  const WORKERS: Set[str]
  /** How many messages wait at the start, by id in the order they arrived. */
  const MESSAGES: int
  /** How many messages one run reads at most (batchSize). */
  const BATCH: int
  /** The messages every reading of which times out, such as one too long for the endpoint. */
  const ALWAYS_TIME_OUT: Set[int]
  /** The messages every reading of which the endpoint answers with invalid output. */
  const ALWAYS_INVALID: Set[int]
  /**
   * How many failed attempts fail a message. 0 is the code as it was before this spec: nothing
   * counted, a message failing every time was read again on every run.
   */
  const MAX_FAILURES: int
  /** Whether a run checks a message still waits right before each reading of it. */
  const CHECK_BEFORE_READING: bool
  /** Bounds on what may go wrong in one execution, so that random traces reach long ones. */
  const MAX_CRASHES: int
  const MAX_OUTAGES: int
  const MAX_RETRIES: int

  // ---- State ----------------------------------------------------------------------------------

  /** A message's row of `source_record`, and its Items. */
  type Message = {
    /** `processed_at` is set. */
    processed: bool,
    /** It has Items (or was read and stated none): written in the same transaction. */
    written: bool,
    /** `extraction_failures`. */
    failures: int,
    /** `extraction_failed_at` is set. */
    failed: bool,
  }

  /** What a reading's answer was. */
  type Outcome = Passing | FailingChecks | InvalidOutput | Timeout | Unreachable

  /**
   * Where a worker's run is: Idle (no run), Running (between messages), Checked (the message still
   * waits; its reading to start), Reading (the endpoint's call under way), Answered (the outcome to
   * be recorded).
   */
  type Phase = Idle | Running | Checked | Reading | Answered

  type Run = {
    phase: Phase,
    /** The messages of its batch it has yet to read, oldest first. */
    batch: List[int],
    current: int,
    /** How many times it has called the endpoint for the current message. */
    readings: int,
    outcome: Outcome,
    /** The messages it read in this run, or skipped as read meanwhile. */
    attempted: Set[int],
    /** Whether the current message had been read when the run turned to it. */
    foundRead: bool,
  }

  type Did =
    | DidInit | DidTake | DidCheck | DidSkip | DidCall | DidAnswer | DidReadAgain | DidRecord | DidRecordDiscarded
    | DidRecordFailure | DidFail | DidEnd | DidCrash | DidRetry

  /**
   * Ghost state, not in the database: which action fired last, what went wrong so far, how many
   * readings an attempt took at most, whether Items were written twice or apart from
   * `processed_at`, whether a run read a message it found read, and how
   * often each message waiting was passed over by a run that ended without reading it.
   */
  type Ghost = {
    lastAction: Did,
    crashes: int,
    outages: int,
    retries: int,
    mostReadings: int,
    writtenTwice: bool,
    readAfterProcessed: bool,
    passedOver: int -> int,
    timesRead: int -> int,
  }

  var messages: int -> Message
  var runs: str -> Run
  var ghost: Ghost

  // ---- Functional logic -----------------------------------------------------------------------

  /** Whether a message waits to be read (pendingMessage). */
  pure def waits(m: Message): bool = not(m.processed) and not(m.failed)

  /** The oldest messages waiting, at most `limit` (pendingMessages). */
  pure def oldestWaiting(ms: int -> Message, count: int, limit: int): List[int] = {
    val waiting = range(1, count + 1).select(id => waits(ms.get(id)))
    waiting.slice(0, if (waiting.length() < limit) waiting.length() else limit)
  }

  /** The outcomes a reading of message `id` may have. */
  pure def outcomesOf(id: int, alwaysTimeOut: Set[int], alwaysInvalid: Set[int]): Set[Outcome] =
    if (alwaysTimeOut.contains(id)) Set(Timeout)
    else if (alwaysInvalid.contains(id)) Set(InvalidOutput)
    else Set(Passing, FailingChecks, InvalidOutput, Timeout)

  /** Whether an outcome is the message's own failure, counted against it. */
  pure def countsAgainst(o: Outcome): bool = o == InvalidOutput or o == Timeout

  /** Whether an outcome ends the run: the endpoint would fail the same way for the rest. */
  pure def endsRun(o: Outcome): bool = o == Timeout or o == Unreachable

  /**
   * The message after a successful reading was recorded: read, with its Items. One another run
   * failed meanwhile is read all the same, and no longer failed.
   */
  pure def recorded(m: Message): Message = { ...m, processed: true, written: true, failed: false }

  /**
   * The message after a failed attempt was recorded: one more failure, failed at `max`. With `max`
   * 0 nothing is counted, as before this spec.
   */
  pure def failedOnce(m: Message, max: int): Message =
    if (max == 0) m
    else { ...m, failures: m.failures + 1, failed: m.failures + 1 >= max }

  /** The ghost once a run ends: each message waiting that it did not read was passed over. */
  pure def passOver(g: Ghost, ms: int -> Message, r: Run): Ghost =
    { ...g, passedOver: g.passedOver.keys().mapBy(id =>
        g.passedOver.get(id) + (if (waits(ms.get(id)) and not(r.attempted.contains(id))) 1 else 0)) }

  // ---- Helpers --------------------------------------------------------------------------------

  val idleRun: Run = { phase: Idle, batch: List(), current: 0, readings: 0, outcome: Passing, attempted: Set(), foundRead: false }
  val unread: Message = { processed: false, written: false, failures: 0, failed: false }

  /** The run of `w` goes on to the next message of its batch. */
  pure def nextMessage(r: Run): Run = { ...r, phase: Running, readings: 0 }

  action did(name: Did): bool = ghost' = { ...ghost, lastAction: name }

  // ---- Actions --------------------------------------------------------------------------------

  action init = all {
    messages' = 1.to(MESSAGES).mapBy(_ => unread),
    runs' = WORKERS.mapBy(_ => idleRun),
    ghost' = {
      lastAction: DidInit, crashes: 0, outages: 0, retries: 0, mostReadings: 0,
      writtenTwice: false, readAfterProcessed: false, passedOver: 1.to(MESSAGES).mapBy(_ => 0),
      timesRead: 1.to(MESSAGES).mapBy(_ => 0),
    },
  }

  /** A run begins with the oldest messages waiting; with none, it does not begin. */
  action take(w: str): bool = {
    val batch = oldestWaiting(messages, MESSAGES, BATCH)
    all {
      runs.get(w).phase == Idle, batch.length() > 0,
      runs' = runs.set(w, { ...idleRun, phase: Running, batch: batch }),
      messages' = messages, did(DidTake),
    }
  }

  /**
   * The run turns to the next message of its batch: it reads it, or, checking first, skips it once
   * another run read it, failed it, or an Admin's retry is still to come.
   */
  action check(w: str): bool = {
    val r = runs.get(w)
    val id = r.batch.head()
    // Checking again before its second reading, it keeps the count of its readings.
    val readings = if (id == r.current) r.readings else 0
    val turned = { ...r, batch: r.batch.tail(), current: id, readings: readings, attempted: r.attempted.union(Set(id)),
                   foundRead: messages.get(id).processed }
    all {
      r.phase == Running, r.batch.length() > 0,
      messages' = messages,
      if (CHECK_BEFORE_READING and not(waits(messages.get(id))))
        all { runs' = runs.set(w, { ...turned, phase: Running }), did(DidSkip) }
      else
        all { runs' = runs.set(w, { ...turned, phase: Checked }), did(DidCheck) },
    }
  }

  /** The endpoint's call starts: a first reading, or the second once an Item failed a check. */
  action call(w: str): bool = {
    val r = runs.get(w)
    val readings = r.readings + 1
    all {
      r.phase == Checked,
      runs' = runs.set(w, { ...r, phase: Reading, readings: readings }),
      messages' = messages,
      ghost' = { ...ghost, lastAction: DidCall,
                 mostReadings: if (readings > ghost.mostReadings) readings else ghost.mostReadings,
                 readAfterProcessed: ghost.readAfterProcessed or r.foundRead,
                 timesRead: ghost.timesRead.setBy(r.current, n => n + 1) },
    }
  }

  /**
   * The call answers. Items failing a check the first time read the message again (checked again
   * first); the second reading counts, its failing Items unwritten.
   */
  action answer(w: str, o: Outcome): bool = {
    val r = runs.get(w)
    all {
      r.phase == Reading,
      o == Unreachable or outcomesOf(r.current, ALWAYS_TIME_OUT, ALWAYS_INVALID).contains(o),
      o != Unreachable or ghost.outages < MAX_OUTAGES,
      messages' = messages,
      if (o == FailingChecks and r.readings == 1) all {
        runs' = runs.set(w, { ...r, phase: if (CHECK_BEFORE_READING) Running else Checked,
                                    // Checking again, it turns to the same message once more.
                                    batch: if (CHECK_BEFORE_READING) List(r.current).concat(r.batch) else r.batch }),
        did(DidReadAgain),
      } else all {
        runs' = runs.set(w, { ...r, phase: Answered, outcome: o }),
        ghost' = { ...ghost, lastAction: DidAnswer, outages: ghost.outages + (if (o == Unreachable) 1 else 0) },
      },
    }
  }

  /**
   * A reading whose Items passed, or whose second reading came with some failing, is recorded:
   * `processed_at` and the Items in one transaction, unless the message no longer waits (another
   * run read it first, or it was withdrawn), when nothing is written.
   */
  action record(w: str): bool = {
    val r = runs.get(w)
    val m = messages.get(r.current)
    all {
      r.phase == Answered, r.outcome == Passing or r.outcome == FailingChecks,
      runs' = runs.set(w, nextMessage(r)),
      if (not(m.processed)) all {
        messages' = messages.set(r.current, recorded(m)),
        ghost' = { ...ghost, lastAction: DidRecord, writtenTwice: ghost.writtenTwice or m.written },
      } else all { messages' = messages, did(DidRecordDiscarded) },
    }
  }

  /**
   * A failed attempt is recorded against its message, unless it no longer waits; a timeout then
   * ends the run, since the endpoint may be slow for every message.
   */
  action recordFailure(w: str): bool = {
    val r = runs.get(w)
    val m = messages.get(r.current)
    val after = failedOnce(m, MAX_FAILURES)
    val written = if (waits(m)) messages.set(r.current, after) else messages
    all {
      r.phase == Answered, countsAgainst(r.outcome),
      messages' = written,
      if (endsRun(r.outcome)) all {
        runs' = runs.set(w, idleRun),
        ghost' = { ...passOver(ghost, written, r), lastAction: if (waits(m) and after.failed) DidFail else DidRecordFailure },
      } else all {
        runs' = runs.set(w, nextMessage(r)),
        did(if (waits(m) and after.failed) DidFail else DidRecordFailure),
      },
    }
  }

  /**
   * The run ends: its batch is through, or the endpoint could not be reached. An unreachable
   * endpoint is the run's failure, not a message's: those it did not read are not passed over.
   */
  action end(w: str): bool = {
    val r = runs.get(w)
    all {
      or {
        r.phase == Running and r.batch.length() == 0,
        r.phase == Answered and r.outcome == Unreachable,
      },
      runs' = runs.set(w, idleRun),
      messages' = messages,
      ghost' = if (r.phase == Answered) { ...ghost, lastAction: DidEnd }
               else { ...passOver(ghost, messages, r), lastAction: DidEnd },
    }
  }

  /** A worker dies in its run; what it committed stays. */
  action crash(w: str): bool = all {
    runs.get(w).phase != Idle, ghost.crashes < MAX_CRASHES,
    runs' = runs.set(w, idleRun),
    messages' = messages,
    ghost' = { ...ghost, lastAction: DidCrash, crashes: ghost.crashes + 1 },
  }

  /** An Admin retries a failed message: its failures are forgotten, and it waits again. */
  action retry(id: int): bool = {
    val m = messages.get(id)
    all {
      m.failed, not(m.processed), ghost.retries < MAX_RETRIES,
      messages' = messages.set(id, { ...m, failures: 0, failed: false }),
      runs' = runs,
      // Its count of readings starts again, for the bound.
      ghost' = { ...ghost, lastAction: DidRetry, retries: ghost.retries + 1,
                 timesRead: ghost.timesRead.set(id, 0) },
    }
  }

  action step = {
    nondet w = WORKERS.oneOf()
    nondet o = Set(Passing, FailingChecks, InvalidOutput, Timeout, Unreachable).oneOf()
    nondet id = 1.to(MESSAGES).oneOf()
    any {
      take(w), check(w), call(w), answer(w, o), record(w), recordFailure(w), end(w), crash(w), retry(id),
    }
  }

  // ---- Properties -----------------------------------------------------------------------------

  /** No attempt reads a message more than twice. */
  val atMostTwoReadings: bool = ghost.mostReadings <= 2 and WORKERS.forall(w => runs.get(w).readings <= 2)

  /** Items and `processed_at` are written together or not at all, and the Items only once. */
  val itemsWithProcessed: bool =
    1.to(MESSAGES).forall(id => messages.get(id).written == messages.get(id).processed) and not(ghost.writtenTwice)

  /**
   * A message with Items is not read again: no run reads a message that had been read when it
   * turned to it. Two runs turning to a message at once, before either recorded, both read it; the
   * second recording is discarded (`itemsWithProcessed`). This is accepted, as it takes the
   * schedule and a trigger reading the same message at the same moment.
   */
  val processedNotReadAgain: bool = not(ghost.readAfterProcessed)

  /** A read message never fails, and a failed one has failed MAX_FAILURES times. */
  val failedOnlyUnread: bool = 1.to(MESSAGES).forall(id => {
    val m = messages.get(id)
    not(m.failed and m.processed) and (not(m.failed) or m.failures == MAX_FAILURES)
  })

  val safety: bool = atMostTwoReadings and itemsWithProcessed and processedNotReadAgain and failedOnlyUnread

  /**
   * How many attempts a message has at most before it is read or failed, since it arrived or an
   * Admin retried it: each counted failure, the one that reads it, one cut short by each crash and
   * each outage, and one under way on each other worker when it was read or failed.
   */
  val attemptsBound: int = MAX_FAILURES + 1 + MAX_CRASHES + MAX_OUTAGES + WORKERS.size() - 1

  /** How often a message is read at most before it is read or failed: twice per attempt. */
  val readBound: int = 2 * attemptsBound

  /**
   * How many runs pass a message over at most: each read an older message waiting, as only
   * messages older than it are taken before it, and each older one has attemptsBound attempts.
   */
  val passOverBound: int = (MESSAGES - 1) * attemptsBound

  /** Every message ends read, or failed and retryable: it is read, and reached, a bounded number of times. */
  val messagesSettle: bool = readAtMost(readBound) and passedOverAtMost(passOverBound)

  /**
   * Liveness as a bound: a message waiting is passed over by at most PASS_OVER_BOUND runs that end
   * without reading it, however often older messages fail. Each such run read an older message
   * waiting, which then is read, or has one more failure towards MAX_FAILURES; an Admin's retry
   * starts its count again. Every message therefore ends read, or failed and retryable.
   */
  def passedOverAtMost(bound: int): bool = 1.to(MESSAGES).forall(id => ghost.passedOver.get(id) <= bound)

  /**
   * Liveness as a bound: a message is read at most `bound` times since it arrived or an Admin
   * retried it. Every reading of it ends read, with a failure counted, or with its run crashed or
   * its endpoint unreachable, which happen a bounded number of times.
   */
  def readAtMost(bound: int): bool = 1.to(MESSAGES).forall(id => ghost.timesRead.get(id) <= bound)

  // ---- Witnesses: each action fires, and the states the properties speak of are reached -------

  val firesTake: bool = ghost.lastAction == DidTake
  val firesCheck: bool = ghost.lastAction == DidCheck
  val firesSkip: bool = ghost.lastAction == DidSkip
  val firesCall: bool = ghost.lastAction == DidCall
  val firesAnswer: bool = ghost.lastAction == DidAnswer
  val firesReadAgain: bool = ghost.lastAction == DidReadAgain
  val firesRecord: bool = ghost.lastAction == DidRecord
  val firesRecordDiscarded: bool = ghost.lastAction == DidRecordDiscarded
  val firesRecordFailure: bool = ghost.lastAction == DidRecordFailure
  val firesFail: bool = ghost.lastAction == DidFail
  val firesEnd: bool = ghost.lastAction == DidEnd
  val firesCrash: bool = ghost.lastAction == DidCrash
  val firesRetry: bool = ghost.lastAction == DidRetry
  /** A second reading under way. */
  val secondReading: bool = WORKERS.exists(w => runs.get(w).readings == 2)
  /** Every message ends read, or failed and retryable. */
  val allSettled: bool = 1.to(MESSAGES).forall(id => not(waits(messages.get(id))))
  /** A message read after an Admin retried it. */
  val readAfterRetry: bool = ghost.retries > 0 and 1.to(MESSAGES).exists(id => messages.get(id).processed)
}
