// Scenarios of Source Records and the instances of their model that `check.sh` checks (sourceRecords.qnt).
module scenarios {
  import sourceRecords.* from "./sourceRecords"
  export sourceRecords.*

  /** A run that delivers these messages and withdraws those, then records. */
  action runs(delivered: Set[str], withdrawn: Set[str]): bool = call(delivered, withdrawn).then(record)

  /** m1 arrives, is recorded and read with an Item lasting until `endsAt`. */
  action readM1(endsAt: int): bool =
    arrive("m1").then(tick).then(runs(Set("m1"), Set())).then(pick("m1")).then(extract(true, endsAt))

  /** A message delivered again is not read again, and keeps one Source Record. */
  run deliveredAgainIsReadOnce =
    init.then(readM1(3)).then(runs(Set("m1"), Set()))
      .expect(not(pending(records.get("m1"))) and safety)

  /** A withdrawn message loses its Item and content; arriving again, it is not read again. */
  run withdrawnMessageStaysUnread =
    init.then(readM1(3)).then(vanish("m1")).then(runs(Set(), Set("m1")))
      .expect(records.get("m1").withdrawn and not(items.get("m1").present))
      .then(vanish("m1")).then(runs(Set("m1"), Set()))
      .expect(not(records.get("m1").withdrawn) and not(pending(records.get("m1"))) and not(items.get("m1").present) and safety)

  /** A message withdrawn while it is being read gets no Item. */
  run withdrawnWhileReading =
    init.then(arrive("m1")).then(tick).then(runs(Set("m1"), Set())).then(pick("m1"))
      .then(vanish("m1")).then(runs(Set(), Set("m1"))).then(extract(true, 5))
      .expect(not(items.get("m1").present) and safety)

  /** A withdrawn entry stated again writes its Item again (liveness); an unchanged one writes nothing. */
  run withdrawnEntryWritesAgain =
    init.then(restate("e1", 1)).then(runs(Set(), Set()))
      .expect(items.get("e1").value == 1)
      .then(deleteItem("e1")).then(runs(Set(), Set()))
      .expect(not(items.get("e1").present))
      .then(restate("e1", 0)).then(runs(Set(), Set()))
      .expect(records.get("e1").withdrawn)
      .then(restate("e1", 1)).then(runs(Set(), Set()))
      .expect(items.get("e1").present and not(records.get("e1").withdrawn) and safety)

  /** Content no Item needs goes once read; past the period, all content goes (liveness), then the row. */
  run purgedOnceUnneededOrPastPeriod =
    init.then(readM1(2)).then(3.reps(_ => tick)).then(purge)
      .expect(records.get("m1").purged and items.get("m1").present)
      .then(deleteItem("m1")).then((RETENTION + 1).reps(_ => tick)).then(purge)
      .expect(not(records.get("m1").exists) and safety)

  /** An unread message past the period: its content is purged and its row deleted; redelivered, it is ignored. */
  run oldMessageIsIgnored =
    init.then(arrive("m1")).then(tick).then(runs(Set("m1"), Set()))
      .then((RETENTION + 1).reps(_ => tick))
      .expect(pastRetentionIsPurgeable)
      .then(purge).expect(not(records.get("m1").exists))
      .then(runs(Set("m1"), Set()))
      .expect(not(records.get("m1").exists) and safety)

  /**
   * The counterexample: a run reads the clock and calls its plugin, which redelivers m1 (a backfill);
   * during the call m1 passes its retention and the purge deletes its row; the recording, judging
   * retention by the clock it read before the call, inserts m1 anew, and it is read again.
   */
  run purgeDuringCall =
    init.then(arrive("m1")).then(tick).then(runs(Set("m1"), Set())).then(pick("m1")).then(extract(false, 1))
      .then(RETENTION.reps(_ => tick))
      .then(call(Set("m1"), Set()))
      .then(tick).then(purge)
      .expect(not(records.get("m1").exists))
      .then(record)
}

/** The code with the fix: a run judges retention by the clock at its recording. */
module checked {
  import scenarios(MESSAGES = Set("m1", "m2"), ENTRIES = Set("e1"), STATES = Set(1, 2), RETENTION = 3, MAX_TIME = 10, CUTOFF_AT_RECORDING = true).*

  run deliveredAgainIsReadOnceTest = deliveredAgainIsReadOnce
  run withdrawnMessageStaysUnreadTest = withdrawnMessageStaysUnread
  run withdrawnWhileReadingTest = withdrawnWhileReading
  run withdrawnEntryWritesAgainTest = withdrawnEntryWritesAgain
  run purgedOnceUnneededOrPastPeriodTest = purgedOnceUnneededOrPastPeriod
  run oldMessageIsIgnoredTest = oldMessageIsIgnored
  /** The recording ignores the redelivered message, past retention by its own clock. */
  run purgeDuringCallTest = purgeDuringCall.expect(not(records.get("m1").exists) and safety)
}

/** The code before this spec: a run judges retention by the clock it read before the plugin's call. */
module unfixed {
  import scenarios(MESSAGES = Set("m1", "m2"), ENTRIES = Set("e1"), STATES = Set(1, 2), RETENTION = 3, MAX_TIME = 10, CUTOFF_AT_RECORDING = false).*

  run purgeDuringCallTest = purgeDuringCall.then(pick("m1")).then(extract(true, now + 1))
    .expect(not(oneRecordPerExternalId) and not(readOnce) and not(oldNeverComesBack))
}

/** The model Apalache checks exhaustively to a depth: one message, one entry. */
module exhaustive {
  import scenarios(MESSAGES = Set("m1"), ENTRIES = Set("e1"), STATES = Set(1, 2), RETENTION = 1, MAX_TIME = 4, CUTOFF_AT_RECORDING = true).*
}

/** The same without the fix, which Apalache must find the counterexample in. */
module exhaustiveUnfixed {
  import scenarios(MESSAGES = Set("m1"), ENTRIES = Set("e1"), STATES = Set(1, 2), RETENTION = 1, MAX_TIME = 4, CUTOFF_AT_RECORDING = false).*
}
