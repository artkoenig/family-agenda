// A rolling update on one Family's database (ADR-0003, "Migrations expand, then contract"): cores of
// the release before and of the new one serve the Family side by side while the schema moves through
// expand, backfill and contract.
//
// A migration is data, not a spec: `RELEASES` lists, per release, which column its code reads each
// datum from and writes it to, and what its migration adds, copies and drops. To check a new
// migration, describe it in migrations.qnt and add an instance in rollingUpdate_test.qnt (see
// docs/upgrading.md).
//
// A datum is one value the code knows (a Family's id, an Admin session's ID token); a column holds
// the stored copy of one datum. Values are abstract: each write of a datum is a new number, and a
// column holds the number of the write it last saw. Release 0 is the release the update starts
// from: its migration's `adds` is the schema it runs on.
//
// Actions and the code they stand for (apps/api: supplied Families and their prepare, ADR-0003
// amendment "Preparing on opening"):
//   deploy   the operator starts rolling out the next release; only once every running core is of
//            the newest release, so that at most two releases run side by side
//   start    a core of the newest release deployed comes up (a container replaced)
//   stop     a core goes away (replaced, or crashed)
//   open     the first request opening the Family on this core: prepares it if this release has
//            not (one transaction of every migration up to its release, under the migration lock),
//            or is refused (`migrated-by-newer-release`) if a newer release migrated it
//   recheck  the throttled schema check of an opened Family: a newer release migrated it, so the
//            core drops it and refuses its requests from then on
//   write    a request of an open core writing a datum, to every column its release writes it to
//            (reads change nothing, so the invariants check them in every state)
//
// Left out: rows (a column holds one value: what one row does, every row does), several Families
// (each database rolls on its own), constraints and indexes (a dropped constraint the old code relies
// on is a column it reads), the 5 s lock timeout and retries (a migration either commits whole or
// changes nothing), a rollback to the release before.
module rollingUpdate {
  // ---- Parameters -----------------------------------------------------------------------------

  type Col = str
  type Datum = str
  type CoreId = int

  /** What one release's migration does to the schema, in this order: add, copy, drop. */
  type Migration = { adds: Set[Col], copies: Set[(Col, Col)], drops: Set[Col] }

  /**
   * One release: the column its code reads each datum from, the columns it writes each to, and the
   * migration that prepares a database for it.
   */
  type Release = { reads: Datum -> Col, writes: Datum -> Set[Col], migration: Migration }

  /** The releases, oldest first; the update starts on release 0 and ends on the last. */
  const RELEASES: List[Release]
  /** The last release's index, `RELEASES.length() - 1`: Apalache needs it as a constant. */
  const LAST: int
  /** Which datum each column holds a copy of. */
  const DATUM_OF: Col -> Datum
  /** The cores that may run at once. */
  const CORES: Set[CoreId]
  /** The most writes of one datum (counting the value it starts with); bounds the writes, so that the state space is finite. */
  const MAX_WRITES: int

  pure val COLUMNS: Set[Col] = DATUM_OF.keys()
  pure val DATA: Set[Datum] = COLUMNS.map(c => DATUM_OF.get(c))

  /** The columns release `r`'s code reads or writes. */
  pure def used(r: int): Set[Col] = {
    val rel = RELEASES[r]
    rel.reads.keys().map(d => rel.reads.get(d))
      .union(rel.writes.keys().fold(Set(), (acc, d) => acc.union(rel.writes.get(d))))
  }

  // ---- State ----------------------------------------------------------------------------------

  /** A core: whether it runs, its release, and whether it has the Family open (prepared and checked). */
  type Core = { running: bool, release: int, open: bool }

  /** The database: the release that last migrated it and its columns. */
  type Schema = { release: int, columns: Set[Col] }

  var schema: Schema
  /** The write of its datum each column holds; 0 is the default a column is added with. */
  var stored: Col -> int
  /** The last write of each datum; 0 while it was never written (a new datum's default). */
  var latest: Datum -> int
  var cores: CoreId -> Core
  /** The newest release being rolled out. */
  var deployed: int
  /** Ghost: the columns the last migration dropped (empty for any other step). */
  var dropped: Set[Col]
  /** Ghost: the releases of the cores running when that migration committed. */
  var runningAtDrop: Set[int]

  // ---- Functional layer -----------------------------------------------------------------------

  /** Applies release `r`'s migration: add (with the default), copy, drop. */
  pure def migrate(s: Schema, st: Col -> int, r: int): (Schema, Col -> int) = {
    val m = RELEASES[r].migration
    val added = COLUMNS.mapBy(c => if (m.adds.contains(c)) 0 else st.get(c))
    val copied = COLUMNS.mapBy(c => {
      val from = m.copies.filter(p => p._2 == c)
      if (from.size() > 0) added.get(from.fold("", (_, p) => p._1)) else added.get(c)
    })
    ({ release: r, columns: s.columns.union(m.adds).exclude(m.drops) }, copied)
  }

  /** Migrates through every release after the schema's up to `r`, in one transaction. */
  pure def prepare(s: Schema, st: Col -> int, r: int): (Schema, Col -> int) =
    // In release order, over the constant range of all releases, as Apalache needs.
    range(1, LAST + 1).foldl((s, st), (acc, i) => if (s.release < i and i <= r) migrate(acc._1, acc._2, i) else acc)

  /** The columns every migration after the schema's up to `r` drops. */
  pure def dropsUpTo(s: Schema, r: int): Set[Col] =
    1.to(LAST).filter(i => s.release < i and i <= r).fold(Set(), (acc, i) => acc.union(RELEASES[i].migration.drops))

  pure def canOpen(c: Core, s: Schema): bool = c.running and not(c.open) and s.release <= c.release

  pure def canWrite(c: Core, d: Datum, n: int): bool =
    c.open and RELEASES[c.release].writes.keys().contains(d) and n <= MAX_WRITES

  /** Whether the update is done: every core runs the last release, and the database is on it. */
  def finished: bool = and {
    deployed == LAST,
    schema.release == LAST,
    CORES.forall(c => cores.get(c).running implies cores.get(c).release == LAST),
  }

  def runningReleases: Set[int] = CORES.filter(c => cores.get(c).running).map(c => cores.get(c).release)

  // ---- Actions --------------------------------------------------------------------------------

  action init: bool = {
    val initial = RELEASES[0].migration.adds
    all {
      schema' = { release: 0, columns: initial },
      stored' = COLUMNS.mapBy(c => if (initial.contains(c)) 1 else 0),
      latest' = DATA.mapBy(d => if (initial.exists(c => DATUM_OF.get(c) == d)) 1 else 0),
      cores' = CORES.mapBy(c => { running: true, release: 0, open: true }),
      deployed' = 0,
      dropped' = Set(),
      runningAtDrop' = Set(),
    }
  }

  action deploy: bool = all {
    deployed < LAST,
    runningReleases.forall(r => r == deployed),
    deployed' = deployed + 1,
    dropped' = Set(),
    runningAtDrop' = Set(),
    schema' = schema, stored' = stored, latest' = latest, cores' = cores,
  }

  action start(id: CoreId): bool = all {
    not(cores.get(id).running),
    cores' = cores.set(id, { running: true, release: deployed, open: false }),
    dropped' = Set(),
    runningAtDrop' = Set(),
    schema' = schema, stored' = stored, latest' = latest, deployed' = deployed,
  }

  action stop(id: CoreId): bool = all {
    cores.get(id).running,
    cores' = cores.set(id, { ...cores.get(id), running: false, open: false }),
    dropped' = Set(),
    runningAtDrop' = Set(),
    schema' = schema, stored' = stored, latest' = latest, deployed' = deployed,
  }

  action open(id: CoreId): bool = {
    val c = cores.get(id)
    val prepared = prepare(schema, stored, c.release)
    all {
      canOpen(c, schema),
      schema' = prepared._1,
      stored' = prepared._2,
      cores' = cores.set(id, { ...c, open: true }),
      dropped' = dropsUpTo(schema, c.release),
      runningAtDrop' = runningReleases,
      latest' = latest, deployed' = deployed,
    }
  }

  action recheck(id: CoreId): bool = {
    val c = cores.get(id)
    all {
      c.open,
      schema.release > c.release,
      cores' = cores.set(id, { ...c, open: false }),
      dropped' = Set(),
      runningAtDrop' = Set(),
      schema' = schema, stored' = stored, latest' = latest, deployed' = deployed,
    }
  }

  action write(id: CoreId, d: Datum): bool = {
    val c = cores.get(id)
    val n = latest.get(d) + 1
    val cols = RELEASES[c.release].writes.get(d).intersect(schema.columns)
    all {
      canWrite(c, d, n),
      latest' = latest.set(d, n),
      stored' = COLUMNS.mapBy(col => if (cols.contains(col)) n else stored.get(col)),
      dropped' = Set(),
      runningAtDrop' = Set(),
      schema' = schema, cores' = cores, deployed' = deployed,
    }
  }

  action step: bool = {
    nondet id = CORES.oneOf()
    nondet d = DATA.oneOf()
    any { deploy, start(id), stop(id), open(id), recheck(id), write(id, d) }
  }

  // ---- Properties -----------------------------------------------------------------------------

  /** No core with the Family open reads or writes a column the database does not have. */
  val columnsExist: bool =
    CORES.forall(id => cores.get(id).open implies used(cores.get(id).release).subseteq(schema.columns))

  /** Every datum an open core reads holds the last value written to it, by whichever release. */
  val noValueLost: bool = CORES.forall(id => {
    val c = cores.get(id)
    val reads = RELEASES[c.release].reads
    c.open implies reads.keys().forall(d => stored.get(reads.get(d)) == latest.get(d))
  })

  /** A migration drops a column only while no running core, of any release, uses it. */
  val contractWithoutOldCores: bool =
    runningAtDrop.forall(r => used(r).intersect(dropped).size() == 0)

  val safety: bool = columnsExist and noValueLost and contractWithoutOldCores

  /**
   * Liveness, as what keeps it possible (ADR-0012): until the update is finished, a step towards it
   * is enabled — deploying, starting a core, opening one, rechecking a stale one or stopping an old one.
   */
  val canFinish: bool = or {
    finished,
    deployed < LAST and runningReleases.forall(r => r == deployed),
    CORES.exists(id => not(cores.get(id).running)),
    CORES.exists(id => canOpen(cores.get(id), schema)),
    CORES.exists(id => cores.get(id).running and cores.get(id).release < deployed),
  }

  // Witnesses
  val updateFinished: bool = finished
  val overlapOnNewSchema: bool = schema.release > 0 and CORES.exists(id => cores.get(id).open and cores.get(id).release < schema.release)
  val contracted: bool = dropped.size() > 0
  val staleCoreRefuses: bool = CORES.exists(id => cores.get(id).running and not(cores.get(id).open) and cores.get(id).release < schema.release)
}
