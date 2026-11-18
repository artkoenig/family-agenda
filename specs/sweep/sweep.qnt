// How secrets that nothing refers to are removed (ADR-0005, ADR-0003): directly, by the caller
// after its commit, and by the sweep as the safety net, which removes only what is older than an
// hour and runs from a pg-boss schedule, so that two workers on one database sweep once.
//
// One reference: a secret field of one Source (`source.secret_refs`); references of different
// rows do not interact. Its writers are an Admin's edit and a Source run storing a refreshed
// secret, running at once (an edit takes no turn). A writer replaces the field (storing its new
// secret, committing the reference, then removing the old secret), drops it (the Source removed),
// or keeps it while changing another field. Any of them may crash at any point. The sweep's
// workers run concurrently with them. Time is a counter the database's `now()` follows.
//
// Files follow the same protocol (`source_record_attachment.blob`, `family_member.photo_blob`),
// once the BlobStore has its `list()`; ADR-0005 says only the secret half exists so far.
//
// Left out: a Source's other secret fields (independent references, once a write touches only the
// fields it changes); secrets a Source's plugin sets when it is added (a replacing write of a
// reference no one else knows yet); the LLM endpoint's `api_key_ref`, written by Admins alone, of
// which two saving at once, one keeping the key and one replacing it, can still leave the endpoint
// referring to a removed key, which is accepted as it takes two Admins in the same instant; the
// schedule's times, as only that the sweep starts again matters.
//
// Actions and the code they stand for (application: secret-sweep.ts, sources.ts applyEdit,
// polling.ts storeChangedSecrets, llm-endpoint.ts; adapters: PgBossWorkRunner, the repositories):
//   begin            an edit or a run reads the Source (or the endpoint) and the reference it holds
//   store            SecretStore.put: the new secret, with `created_at` now
//   commit           SourceRepository.update, replaceSecretsInTurn, LlmEndpointRepository.save/remove
//   removeOld        the caller's SecretStore.remove of the secret it replaced, after the commit
//   crash            the process dies, or the request fails, before it finished
//   start            pg-boss hands the queued sweep (on start, or daily) to one worker
//   readClock        clock.now(), from which the sweep's `before` is an hour back
//   readReferences   sources.list() and endpoints.find()
//   list, removeOne  SecretStore.list(), the filter, and SecretStore.remove of each
//   finish           the job completes
//   expire           pg-boss fails a job whose heartbeat stopped, or that ran past `expireInSeconds`
//   pause, resume    a worker stops altogether for a while (a suspended VM, a partition)
module sweep {
  // ---- Parameters -----------------------------------------------------------------------------

  /** The ids SecretStore.put hands out, one per put; 0 stands for no reference. */
  const IDS: Set[int]
  /** The edits and runs writing the reference. */
  const WRITERS: Set[str]
  /** The worker containers on the database. */
  const WORKERS: Set[str]
  /** How old an unreferenced secret must be for the sweep to remove it (one hour). */
  const AGE: int
  /** The longest a writer takes from reading the reference to its commit. */
  const LONGEST: int
  /** After how long pg-boss expires a job, heartbeats or not (`expireInSeconds`, one hour). */
  const EXPIRE: int
  /** After how long without a heartbeat pg-boss fails a job (`heartbeatSeconds`, a minute). */
  const HEARTBEAT: int
  /** Whether a worker may stop for a while, losing its heartbeat. */
  const STALLS: bool
  /**
   * Whether the sweep reads the clock before the references. False is the code before this spec:
   * the references first, so that a sweep stalling between the two judges a secret referred to
   * meanwhile by its old snapshot.
   */
  const CLOCK_FIRST: bool
  /**
   * Whether a commit writes only the references it changes. False is the code before this spec: an
   * edit or a run writes the whole `secret_refs` it read, so that one keeping a field writes back a
   * secret another replaced and removed meanwhile.
   */
  const CHANGED_ONLY: bool
  /** Bounds the clock, so that the state space is finite. */
  const MAX_TIME: int

  // ---- State ----------------------------------------------------------------------------------

  /** A row of the `secret` table; `stored` false means none. `used`: put once, maybe removed since. */
  type Secret = { stored: bool, used: bool, storedAt: int }

  /** What a writer does to the reference: replaces it, keeps it (an edit of other fields), or drops it. */
  type Kind = Replace | Keep | Drop

  type WriterPhase = WIdle | Begun | Stored | Committed

  /** A writer: the reference it read, and the new secret it stored. */
  type Writer = { phase: WriterPhase, kind: Kind, read: int, fresh: int, beganAt: int }

  /** A worker's sweep; `idle` false while it runs, whether or not pg-boss still counts it. */
  type Sweeper = {
    idle: bool,
    clockRead: bool,
    before: int,
    refsRead: bool,
    refs: Set[int],
    orphansAtRefs: Set[int],
    listed: bool,
    pending: Set[int],
    paused: bool,
  }

  /** The sweep's pg-boss job: its queue is exclusive, so at most one is active. */
  type Job = { active: bool, holder: str, startedAt: int, beatAt: int }

  var now: int
  var secrets: int -> Secret
  /** The committed reference, 0 for none. */
  var reference: int
  var writers: str -> Writer
  var sweepers: str -> Sweeper
  var job: Job
  /** Ghost: the secrets a sweep removed while something referred to them. */
  var sweptReferenced: Set[int]
  /** Ghost: the orphans a finished sweep left that were orphans already when it read the references. */
  var missed: Set[int]

  // ---- Functional layer -----------------------------------------------------------------------

  pure val idleWriter: Writer = { phase: WIdle, kind: Keep, read: 0, fresh: 0, beganAt: 0 }
  pure val idleSweeper: Sweeper =
    { idle: true, clockRead: false, before: 0, refsRead: false, refs: Set(), orphansAtRefs: Set(), listed: false, pending: Set(), paused: false }

  /** The secrets a running writer refers to: the new one it stored and has not committed yet. */
  def heldByWriters: Set[int] = WRITERS.filter(w => writers.get(w).phase == Stored).map(w => writers.get(w).fresh)

  def referenced: Set[int] = heldByWriters.union(if (reference == 0) Set() else Set(reference))

  /** What the reference becomes when a writer commits. */
  pure def committed(w: Writer, current: int): int =
    match w.kind {
      | Replace => w.fresh
      | Drop => 0
      | Keep => if (CHANGED_ONLY) current else w.read
    }

  /** The sweep may read the references now: after the clock, or first in the old code. */
  pure def mayReadRefs(s: Sweeper): bool = not(s.refsRead) and (s.clockRead or not(CLOCK_FIRST))
  pure def mayReadClock(s: Sweeper): bool = not(s.clockRead) and (s.refsRead or CLOCK_FIRST)

  /** The secrets a listing finds to remove: unreferenced by the snapshot, stored before `before`. */
  pure def toRemove(stock: int -> Secret, s: Sweeper): Set[int] =
    stock.keys().filter(id => stock.get(id).stored and stock.get(id).storedAt < s.before and not(s.refs.contains(id)))

  /**
   * A secret nothing refers to, nor will: stored, unreferenced, and not the old secret of a writer
   * (which removes it, or, keeping it, writes it back).
   */
  def orphans: Set[int] = IDS.filter(id => secrets.get(id).stored and not(referenced.contains(id))
    and WRITERS.forall(w => writers.get(w).phase == WIdle or writers.get(w).read != id))

  def runs(k: str): bool = not(sweepers.get(k).idle) and not(sweepers.get(k).paused)

  // ---- Actions --------------------------------------------------------------------------------

  action init = all {
    now' = 0,
    secrets' = IDS.mapBy(_ => { stored: false, used: false, storedAt: 0 }),
    reference' = 0,
    writers' = WRITERS.mapBy(_ => idleWriter),
    sweepers' = WORKERS.mapBy(_ => idleSweeper),
    job' = { active: false, holder: "", startedAt: 0, beatAt: 0 },
    sweptReferenced' = Set(),
    missed' = Set(),
  }

  /**
   * Time passes; a running worker's heartbeat follows it. No writer outlasts LONGEST, and no worker
   * that runs takes until its job expires: only a stalled one does.
   */
  action tick = all {
    now < MAX_TIME,
    WRITERS.forall(w => writers.get(w).phase != WIdle and writers.get(w).phase != Committed
      implies now + 1 - writers.get(w).beganAt <= LONGEST),
    WORKERS.forall(k => runs(k) and job.active and job.holder == k implies now + 1 - job.startedAt < EXPIRE),
    now' = now + 1,
    job' = if (job.active and runs(job.holder)) { ...job, beatAt: now + 1 } else job,
    secrets' = secrets, reference' = reference, writers' = writers, sweepers' = sweepers, sweptReferenced' = sweptReferenced, missed' = missed,
  }

  action begin(w: str, kind: Kind): bool = all {
    writers.get(w).phase == WIdle,
    kind == Keep implies reference != 0,
    writers' = writers.set(w, { phase: Begun, kind: kind, read: reference, fresh: 0, beganAt: now }),
    now' = now, secrets' = secrets, reference' = reference, sweepers' = sweepers, job' = job, sweptReferenced' = sweptReferenced, missed' = missed,
  }

  action store(w: str, id: int): bool = all {
    writers.get(w).phase == Begun,
    writers.get(w).kind == Replace,
    // A put hands out an id never used before.
    not(secrets.get(id).used),
    secrets' = secrets.set(id, { stored: true, used: true, storedAt: now }),
    writers' = writers.set(w, { ...writers.get(w), phase: Stored, fresh: id }),
    now' = now, reference' = reference, sweepers' = sweepers, job' = job, sweptReferenced' = sweptReferenced, missed' = missed,
  }

  action commit(w: str): bool = {
    val wr = writers.get(w)
    all {
      if (wr.kind == Replace) wr.phase == Stored else wr.phase == Begun,
      reference' = committed(wr, reference),
      writers' = writers.set(w, { ...wr, phase: Committed }),
      now' = now, secrets' = secrets, sweepers' = sweepers, job' = job, sweptReferenced' = sweptReferenced, missed' = missed,
    }
  }

  action removeOld(w: str): bool = {
    val wr = writers.get(w)
    all {
      wr.phase == Committed,
      secrets' = if (wr.kind != Keep and wr.read != 0) secrets.setBy(wr.read, s => { ...s, stored: false }) else secrets,
      writers' = writers.set(w, idleWriter),
      now' = now, reference' = reference, sweepers' = sweepers, job' = job, sweptReferenced' = sweptReferenced, missed' = missed,
    }
  }

  action crash(w: str): bool = all {
    writers.get(w).phase != WIdle,
    writers' = writers.set(w, idleWriter),
    now' = now, secrets' = secrets, reference' = reference, sweepers' = sweepers, job' = job, sweptReferenced' = sweptReferenced, missed' = missed,
  }

  /** The exclusive queue hands the sweep to a worker only while no job of it is active. */
  action start(k: str): bool = all {
    not(job.active),
    sweepers.get(k).idle,
    not(sweepers.get(k).paused),
    job' = { active: true, holder: k, startedAt: now, beatAt: now },
    sweepers' = sweepers.set(k, { ...idleSweeper, idle: false }),
    now' = now, secrets' = secrets, reference' = reference, writers' = writers, sweptReferenced' = sweptReferenced, missed' = missed,
  }

  action readClock(k: str): bool = all {
    runs(k),
    mayReadClock(sweepers.get(k)),
    sweepers' = sweepers.setBy(k, s => { ...s, clockRead: true, before: now - AGE }),
    now' = now, secrets' = secrets, reference' = reference, writers' = writers, job' = job, sweptReferenced' = sweptReferenced, missed' = missed,
  }

  action readReferences(k: str): bool = all {
    runs(k),
    mayReadRefs(sweepers.get(k)),
    sweepers' = sweepers.setBy(k, s => { ...s, refsRead: true, refs: if (reference == 0) Set() else Set(reference), orphansAtRefs: orphans }),
    now' = now, secrets' = secrets, reference' = reference, writers' = writers, job' = job, sweptReferenced' = sweptReferenced, missed' = missed,
  }

  action list(k: str): bool = {
    val s = sweepers.get(k)
    all {
      runs(k),
      s.clockRead and s.refsRead and not(s.listed),
      sweepers' = sweepers.set(k, { ...s, listed: true, pending: toRemove(secrets, s) }),
      now' = now, secrets' = secrets, reference' = reference, writers' = writers, job' = job, sweptReferenced' = sweptReferenced, missed' = missed,
    }
  }

  action removeOne(k: str, id: int): bool = all {
    runs(k),
    sweepers.get(k).pending.contains(id),
    secrets' = secrets.setBy(id, s => { ...s, stored: false }),
    sweptReferenced' = if (referenced.contains(id)) sweptReferenced.union(Set(id)) else sweptReferenced,
    sweepers' = sweepers.setBy(k, s => { ...s, pending: s.pending.exclude(Set(id)) }),
    now' = now, reference' = reference, writers' = writers, job' = job, missed' = missed,
  }

  action finish(k: str): bool = all {
    runs(k),
    sweepers.get(k).listed and sweepers.get(k).pending == Set(),
    sweepers' = sweepers.set(k, idleSweeper),
    job' = if (job.active and job.holder == k) { ...job, active: false } else job,
    missed' = missed.union(sweepers.get(k).orphansAtRefs.intersect(orphans)
      .filter(id => secrets.get(id).storedAt < sweepers.get(k).before)),
    now' = now, secrets' = secrets, reference' = reference, writers' = writers, sweptReferenced' = sweptReferenced,
  }

  /** A worker dies mid-sweep: its job stays active until its heartbeat is missed. */
  action die(k: str): bool = all {
    not(sweepers.get(k).idle),
    sweepers' = sweepers.set(k, idleSweeper),
    now' = now, secrets' = secrets, reference' = reference, writers' = writers, job' = job, sweptReferenced' = sweptReferenced, missed' = missed,
  }

  action expire: bool = all {
    job.active,
    now - job.beatAt >= HEARTBEAT or now - job.startedAt >= EXPIRE,
    job' = { ...job, active: false },
    now' = now, secrets' = secrets, reference' = reference, writers' = writers, sweepers' = sweepers, sweptReferenced' = sweptReferenced, missed' = missed,
  }

  action pause(k: str): bool = all {
    STALLS,
    not(sweepers.get(k).paused),
    sweepers' = sweepers.setBy(k, s => { ...s, paused: true }),
    now' = now, secrets' = secrets, reference' = reference, writers' = writers, job' = job, sweptReferenced' = sweptReferenced, missed' = missed,
  }

  action resume(k: str): bool = all {
    sweepers.get(k).paused,
    sweepers' = sweepers.setBy(k, s => { ...s, paused: false }),
    now' = now, secrets' = secrets, reference' = reference, writers' = writers, job' = job, sweptReferenced' = sweptReferenced, missed' = missed,
  }

  action step = {
    nondet w = WRITERS.oneOf()
    nondet k = WORKERS.oneOf()
    nondet id = IDS.oneOf()
    nondet kind = Set(Replace, Keep, Drop).oneOf()
    any {
      tick,
      begin(w, kind), store(w, id), commit(w), removeOld(w), crash(w),
      start(k), readClock(k), readReferences(k), list(k), removeOne(k, id), finish(k), die(k), pause(k), resume(k),
      expire,
    }
  }

  // ---- Properties -----------------------------------------------------------------------------

  /** The sweep never removes a secret that the committed reference or a running writer refers to. */
  val sweepSparesReferenced: bool = sweptReferenced == Set()

  /** No reference points at a removed secret: not by the sweep, nor by a caller's removal. */
  val noDanglingReference: bool = reference == 0 or secrets.get(reference).stored

  /** A running writer's new secret is still there when it commits. */
  val runningKeepTheirs: bool = heldByWriters.forall(id => secrets.get(id).stored)

  val safety: bool = sweepSparesReferenced and noDanglingReference and runningKeepTheirs

  /** Two workers on one database never sweep at once. */
  val oneSweep: bool = WORKERS.filter(k => not(sweepers.get(k).idle)).size() <= 1

  /**
   * Liveness, as what keeps it possible (ADR-0012): a sweep removes every secret older than AGE that
   * was an orphan when it read the references; an orphan stays one, as a commit refers only to a
   * secret just put or to the one its writer read, and an orphan is neither; so the next sweep after
   * an orphan is AGE old removes it. That the sweep starts again,
   * also after its worker died, a scenario shows.
   */
  val sweepRemovesOrphans: bool = missed == Set()

  // ---- Witnesses ------------------------------------------------------------------------------

  val secretRemoved: bool = IDS.exists(id => secrets.get(id).used and not(secrets.get(id).stored)
    and reference != id)
  val replaced: bool = reference != 0 and IDS.exists(id => id != reference and secrets.get(id).used and not(secrets.get(id).stored))
  val sweepListedSomething: bool = WORKERS.exists(k => sweepers.get(k).pending != Set())
  val sweepingWithoutJob: bool = not(job.active) and WORKERS.exists(k => not(sweepers.get(k).idle))
  val twoSweeping: bool = not(oneSweep)
}
