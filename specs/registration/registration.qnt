// How a Family comes to exist: cores preparing one database at once, drawing or taking its Family id
// (ADR-0003, "the Family id is chosen or drawn once"), and the Identity Provider's `PostRegister`
// webhook creating the Family's organization and its first Admin (ADR-0010), delivered late, twice,
// or to two replicas at once.
//
// Each action is one statement, one transaction of the core, or one call to the Identity Provider's
// management API, so that the checker interleaves them as the database and the network may. A core
// may crash at any point (its transaction rolls back, its lock is released, what it had called stays
// called); a call to the Identity Provider may fail, which throws.
//
// Preparing (adapters: database.ts `migrate`, family-id.ts `migrateFamily`):
//   lock      pg_advisory_lock, which serialises the cores migrating one database
//   check     storedFamilyId and the refusal of a different id; a current database migrates nothing
//   draw      the migrations, in one transaction: 0008's default draws a random id, and a given id
//             is written by the last one (ID_IN_MIGRATION) or, as before the amendment, afterwards
//   commit    the transaction commits and the lock is released
//   writeId   (only without ID_IN_MIGRATION) the given id written after the migrations committed
//
// Registration (application: registration-events.ts, family-registration.ts, family-created.ts):
//   signUp    a user registers in the Identity Provider while sign-up is open; it delivers the event
//             until a core answers 2xx, to any replica, maybe to two at once
//   receive   ProcessedEventRepository.recordIfNew, then isOpen (fixed mode: no organization yet)
//   create    IdentityDirectory.createOrganization, with the Family id (supplied mode: a new one)
//   addMember IdentityDirectory.addMember
//   record    (fixed) FamilyRepository.recordOrganizationId; the loser goes on to removeMember
//   remove    (fixed) IdentityDirectory.removeMember
//   close     (fixed) IdentityDirectory.closeRegistration, then the answer 204
//   send      (supplied) FamilyCreatedDeliveryRepository.add, then the answer 204
//   deliver   (supplied) a `family.created` delivery the platform takes, supplying the Family's Context
//   throws    a call that throws: processedEvents.forget, the answer 500, so the event comes again
//   crash     a handler's core dies mid-way: nothing forgotten, no answer, the event comes again
//
// Left out: the signature and an unverified email (an ignored event, answered 204 as one seen before);
// invitations (an invitee's registration creates nothing, as one in a closed fixed Instance); the
// migrations themselves beyond the Family id; the in-memory `closed` cache of isOpen (it only ever
// skips to closing); the delivery's lease and backoff (the platform takes a Family id idempotently);
// a supplied Family's database, prepared with the Context's id as above.
module registration {
  // ---- Parameters -----------------------------------------------------------------------------

  /** The cores (api, worker, replicas) starting on the Family's database. */
  const CORES: Set[str]
  /** The Family id each core is given (FAMILY_ID, or the Context's); 0 for none. */
  const GIVEN: str -> int
  /** The users who may register in the Identity Provider. */
  const USERS: Set[str]
  /** Deliveries of the webhook a core may handle at once, on any replica. */
  const HANDLERS: Set[int]
  /** Supplied mode (cloud): every registration creates a Family. False: fixed mode (self-hosted). */
  const SUPPLIED: bool
  /**
   * Whether a given Family id is written in the transaction of the migrations, as the amendment
   * decides. False is the design before it: written once the migrations committed.
   */
  const ID_IN_MIGRATION: bool
  /** Bounds the organizations created and the ids drawn, so that the state space is finite. */
  const MAX_ORGS: int
  const MAX_DRAWS: int

  // ---- State ----------------------------------------------------------------------------------

  type Phase = Down | Locked | Migrating | Migrated | Up | Refused

  /** A core preparing the database; `familyId` the id it serves once Up. */
  type Core = { phase: Phase, drawn: int, familyId: int }

  /** The Family's database: migrated, `family.family_id` (0: no row yet), `organization_id`, `processed_idp_event`. */
  type Db = { migrated: bool, familyId: int, organizationId: int, processed: Set[str] }

  /** An organization in the Identity Provider, with the Family id in its customData. */
  type Org = { familyId: int, members: Set[str] }

  type Stage = Free | ToCreate | ToAddMember | ToRecord | ToRemove | ToClose | ToSend

  /** A delivery of the webhook being handled; `org` and `familyId` what it created so far. */
  type Handler = { stage: Stage, user: str, org: int, familyId: int }

  /** A pending `family.created` delivery (supplied mode). */
  type Delivery = { familyId: int, org: int, user: str }

  type Did =
    | DidInit | DidLock | DidCheck | DidDraw | DidCommit | DidWriteId | DidCrashCore | DidSignUp
    | DidReceive | DidCreate | DidAddMember | DidRecord | DidRemove | DidClose | DidSend | DidDeliver
    | DidFail | DidCrash

  /**
   * Ghost state: the last action; every Family id the database ever held; the organizations each
   * user's registration created; the Families the platform was told of per user.
   */
  type Ghost = { lastAction: Did, familyIds: Set[int], orgsOf: str -> int, familiesOf: str -> Set[int] }

  var cores: str -> Core
  var lockHolder: str
  var db: Db
  var draws: int
  var signUpOpen: bool
  /** The users whose event the Identity Provider still delivers (no 2xx yet). */
  var pending: Set[str]
  var orgs: int -> Org
  var handlers: int -> Handler
  var deliveries: Set[Delivery]
  /** The Families whose Context the platform supplies. */
  var families: Set[int]
  var ghost: Ghost

  // ---- Functional logic -----------------------------------------------------------------------

  val noHandler: Handler = { stage: Free, user: "", org: 0, familyId: 0 }
  val GIVEN_IDS: Set[int] = CORES.map(c => GIVEN.get(c)).exclude(Set(0))

  /** A random id, never one given: drawn ids count from 100. */
  pure def randomId(n: int): int = 100 + n

  /** migrateFamily's refusal: a given id that differs from the one stored. */
  pure def refuses(given: int, stored: int): bool = given != 0 and stored != 0 and stored != given

  /** The id the migrations' transaction leaves in the row: the given one when written inside it. */
  pure def committedId(given: int, drawn: int, inMigration: bool): int =
    if (inMigration and given != 0) given else drawn

  /** Whether a handler is busy with `u`'s event. */
  def handling(u: str): bool = HANDLERS.exists(h => handlers.get(h).stage != Free and handlers.get(h).user == u)

  /** The organization recorded as the Family's, in fixed mode. */
  def familyOrg: int = db.organizationId

  // ---- State machine: preparing ---------------------------------------------------------------

  action did(name: Did): bool = ghost' = { ...ghost, lastAction: name }

  action keepRegistration: bool = all {
    signUpOpen' = signUpOpen, pending' = pending, orgs' = orgs, handlers' = handlers,
    deliveries' = deliveries, families' = families,
  }
  action keepPreparing: bool = all { cores' = cores, lockHolder' = lockHolder, draws' = draws }

  action init = all {
    cores' = CORES.mapBy(_ => { phase: Down, drawn: 0, familyId: 0 }),
    lockHolder' = "",
    db' = { migrated: false, familyId: 0, organizationId: 0, processed: Set() },
    draws' = 0,
    signUpOpen' = true,
    pending' = Set(),
    orgs' = Map(),
    handlers' = HANDLERS.mapBy(_ => noHandler),
    deliveries' = Set(),
    families' = Set(),
    ghost' = { lastAction: DidInit, familyIds: Set(), orgsOf: USERS.mapBy(_ => 0), familiesOf: USERS.mapBy(_ => Set()) },
  }

  action setCore(c: str, core: Core): bool = cores' = cores.set(c, core)

  /** pg_advisory_lock: one core at a time migrates. */
  action lock(c: str): bool = all {
    cores.get(c).phase == Down, lockHolder == "",
    setCore(c, { ...cores.get(c), phase: Locked }), lockHolder' = c,
    db' = db, draws' = draws, keepRegistration, did(DidLock),
  }

  /** storedFamilyId and the refusal; a database migrated already migrates nothing. */
  action check(c: str): bool = {
    val given = GIVEN.get(c)
    all {
      cores.get(c).phase == Locked,
      if (refuses(given, db.familyId)) all { setCore(c, { ...cores.get(c), phase: Refused }), lockHolder' = "" }
      else if (db.migrated) all { setCore(c, { ...cores.get(c), phase: Migrated }), lockHolder' = c }
      else all { setCore(c, { ...cores.get(c), phase: Migrating }), lockHolder' = c },
      db' = db, draws' = draws, keepRegistration, did(DidCheck),
    }
  }

  /** The migrations' transaction runs: the family row's default draws a random id. Not yet committed. */
  action draw(c: str): bool = all {
    cores.get(c).phase == Migrating, cores.get(c).drawn == 0, draws < MAX_DRAWS,
    setCore(c, { ...cores.get(c), drawn: randomId(draws + 1) }), draws' = draws + 1,
    lockHolder' = lockHolder, db' = db, keepRegistration, did(DidDraw),
  }

  /** The transaction commits, the lock is released; a core that migrated nothing only releases it. */
  action commit(c: str): bool = {
    val core = cores.get(c)
    val given = GIVEN.get(c)
    val written = if (core.phase == Migrating) committedId(given, core.drawn, ID_IN_MIGRATION) else db.familyId
    val idLater = core.phase == Migrating and given != 0 and not(ID_IN_MIGRATION)
    all {
      core.phase == Migrated or (core.phase == Migrating and core.drawn != 0),
      db' = { ...db, migrated: true, familyId: written },
      setCore(c, { ...core, phase: if (idLater) Migrated else Up, familyId: if (idLater) 0 else written }),
      lockHolder' = if (idLater) c else "",
      draws' = draws, keepRegistration,
      ghost' = { ...ghost, lastAction: DidCommit, familyIds: ghost.familyIds.union(Set(written)) },
    }
  }

  /** Before the amendment: the given id written after the migrations committed. */
  action writeId(c: str): bool = {
    val given = GIVEN.get(c)
    all {
      not(ID_IN_MIGRATION), cores.get(c).phase == Migrated, lockHolder == c, given != 0, db.familyId != given,
      db' = { ...db, familyId: given },
      setCore(c, { ...cores.get(c), phase: Up, familyId: given }), lockHolder' = "",
      draws' = draws, keepRegistration,
      ghost' = { ...ghost, lastAction: DidWriteId, familyIds: ghost.familyIds.union(Set(given)) },
    }
  }

  /** A core dies while preparing: its transaction rolls back, its session's lock goes. It starts again later. */
  action crashCore(c: str): bool = all {
    Set(Locked, Migrating, Migrated).contains(cores.get(c).phase),
    setCore(c, { phase: Down, drawn: 0, familyId: 0 }),
    lockHolder' = if (lockHolder == c) "" else lockHolder,
    db' = db, draws' = draws, keepRegistration, did(DidCrashCore),
  }

  // ---- State machine: registration ------------------------------------------------------------

  /** Whether a core serves the webhook: in fixed mode one that prepared the Family. */
  val serving: bool = SUPPLIED or CORES.exists(c => cores.get(c).phase == Up)

  action setHandler(h: int, handler: Handler): bool = handlers' = handlers.set(h, handler)

  /** A user registers; the Identity Provider will deliver the event until answered 2xx. */
  action signUp(u: str): bool = all {
    signUpOpen, not(pending.contains(u)), not(db.processed.contains(u)), ghost.orgsOf.get(u) == 0,
    pending' = pending.union(Set(u)),
    signUpOpen' = signUpOpen, orgs' = orgs, handlers' = handlers, deliveries' = deliveries, families' = families,
    db' = db, keepPreparing, did(DidSignUp),
  }

  /** answer 204: the Identity Provider stops delivering. */
  action answered(u: str): bool = pending' = pending.exclude(Set(u))

  /** recordIfNew, then isOpen: an event seen before is ignored (204); a closed Family only closes again. */
  action receive(h: int, u: str): bool = all {
    serving, handlers.get(h).stage == Free, pending.contains(u),
    if (db.processed.contains(u)) all { answered(u), handlers' = handlers, db' = db }
    else all {
      pending' = pending,
      db' = { ...db, processed: db.processed.union(Set(u)) },
      setHandler(h, { ...noHandler, user: u, stage: if (not(SUPPLIED) and familyOrg != 0) ToClose else ToCreate }),
    },
    signUpOpen' = signUpOpen, orgs' = orgs, deliveries' = deliveries, families' = families,
    keepPreparing, did(DidReceive),
  }

  /** createOrganization, with the Family's id, or in supplied mode a new random one. */
  action create(h: int): bool = {
    val handler = handlers.get(h)
    val familyId = if (SUPPLIED) randomId(draws + 1) else db.familyId
    val org = orgs.keys().size() + 1
    all {
      handler.stage == ToCreate, org <= MAX_ORGS, not(SUPPLIED) or draws < MAX_DRAWS,
      orgs' = orgs.put(org, { familyId: familyId, members: Set() }),
      setHandler(h, { ...handler, stage: ToAddMember, org: org, familyId: familyId }),
      draws' = if (SUPPLIED) draws + 1 else draws,
      cores' = cores, lockHolder' = lockHolder, db' = db,
      signUpOpen' = signUpOpen, pending' = pending, deliveries' = deliveries, families' = families,
      ghost' = { ...ghost, lastAction: DidCreate, orgsOf: ghost.orgsOf.set(handler.user, ghost.orgsOf.get(handler.user) + 1) },
    }
  }

  action addMember(h: int): bool = {
    val handler = handlers.get(h)
    all {
      handler.stage == ToAddMember,
      orgs' = orgs.set(handler.org, { ...orgs.get(handler.org), members: orgs.get(handler.org).members.union(Set(handler.user)) }),
      setHandler(h, { ...handler, stage: if (SUPPLIED) ToSend else ToRecord }),
      db' = db, keepPreparing, signUpOpen' = signUpOpen, pending' = pending, deliveries' = deliveries, families' = families,
      did(DidAddMember),
    }
  }

  /** recordOrganizationId: the first organization recorded is the Family's; the loser removes its member. */
  action record(h: int): bool = {
    val handler = handlers.get(h)
    all {
      handler.stage == ToRecord,
      db' = if (db.organizationId == 0) { ...db, organizationId: handler.org } else db,
      setHandler(h, { ...handler, stage: if (db.organizationId == 0) ToClose else ToRemove }),
      keepPreparing, signUpOpen' = signUpOpen, pending' = pending, orgs' = orgs, deliveries' = deliveries, families' = families,
      did(DidRecord),
    }
  }

  action remove(h: int): bool = {
    val handler = handlers.get(h)
    all {
      handler.stage == ToRemove,
      orgs' = orgs.set(handler.org, { ...orgs.get(handler.org), members: orgs.get(handler.org).members.exclude(Set(handler.user)) }),
      setHandler(h, { ...handler, stage: ToClose }),
      db' = db, keepPreparing, signUpOpen' = signUpOpen, pending' = pending, deliveries' = deliveries, families' = families,
      did(DidRemove),
    }
  }

  /** closeRegistration, then the answer 204. */
  action close(h: int): bool = {
    val handler = handlers.get(h)
    all {
      handler.stage == ToClose,
      signUpOpen' = false, answered(handler.user), setHandler(h, noHandler),
      db' = db, keepPreparing, orgs' = orgs, deliveries' = deliveries, families' = families,
      did(DidClose),
    }
  }

  /** FamilyCreatedDeliveryRepository.add, then the answer 204. */
  action send(h: int): bool = {
    val handler = handlers.get(h)
    all {
      handler.stage == ToSend,
      deliveries' = deliveries.union(Set({ familyId: handler.familyId, org: handler.org, user: handler.user })),
      answered(handler.user), setHandler(h, noHandler),
      db' = db, keepPreparing, signUpOpen' = signUpOpen, orgs' = orgs, families' = families,
      did(DidSend),
    }
  }

  /** The platform takes a `family.created` delivery and supplies the Family's Context. */
  action deliver(d: Delivery): bool = all {
    deliveries.contains(d),
    deliveries' = deliveries.exclude(Set(d)), families' = families.union(Set(d.familyId)),
    db' = db, keepPreparing, signUpOpen' = signUpOpen, pending' = pending, orgs' = orgs, handlers' = handlers,
    ghost' = { ...ghost, lastAction: DidDeliver, familiesOf: ghost.familiesOf.set(d.user, ghost.familiesOf.get(d.user).union(Set(d.familyId))) },
  }

  /** A call that throws: the event is forgotten and answered 500, so the Identity Provider delivers it again. */
  action throws(h: int): bool = {
    val handler = handlers.get(h)
    all {
      handler.stage != Free,
      db' = { ...db, processed: db.processed.exclude(Set(handler.user)) },
      setHandler(h, noHandler),
      keepPreparing, signUpOpen' = signUpOpen, pending' = pending, orgs' = orgs, deliveries' = deliveries, families' = families,
      did(DidFail),
    }
  }

  /** The handler's core dies: nothing is forgotten, no answer; the Identity Provider delivers the event again. */
  action crash(h: int): bool = all {
    handlers.get(h).stage != Free,
    setHandler(h, noHandler),
    db' = db, keepPreparing, signUpOpen' = signUpOpen, pending' = pending, orgs' = orgs, deliveries' = deliveries, families' = families,
    did(DidCrash),
  }

  action step = any {
    nondet c = CORES.oneOf()
    any { lock(c), check(c), draw(c), commit(c), writeId(c), crashCore(c) },
    nondet u = USERS.oneOf()
    signUp(u),
    nondet h = HANDLERS.oneOf()
    nondet u = USERS.oneOf()
    any { receive(h, u), create(h), addMember(h), record(h), remove(h), close(h), send(h), throws(h), crash(h) },
    nondet d = deliveries.union(Set({ familyId: 0, org: 0, user: "" })).oneOf()
    deliver(d),
  }

  // ---- Properties -----------------------------------------------------------------------------

  /** The database only ever holds one Family id, and every core serves that one. */
  val oneFamilyId: bool =
    ghost.familyIds.size() <= 1 and CORES.forall(c => cores.get(c).phase == Up implies cores.get(c).familyId == db.familyId)
  /** A failed start leaves no random id behind: a database given an id holds that id or none. */
  val noStrayRandomId: bool = GIVEN_IDS.size() != 1 or db.familyId == 0 or GIVEN_IDS.contains(db.familyId)
  /** One registration event creates at most one organization, and the platform learns of at most one Family. */
  val oneOrganizationPerEvent: bool = USERS.forall(u => ghost.orgsOf.get(u) <= 1 and ghost.familiesOf.get(u).size() <= 1)
  /** Self-hosted, only the first registration creates anything: one organization at most. */
  val onlyFirstCreates: bool = SUPPLIED or orgs.keys().size() <= 1
  /**
   * Self-hosted, only the Family's organization keeps members: any other one is emptied by the
   * registration that created it, unless that registration is still under way.
   */
  val onlyFamilyOrgHasAdmins: bool = SUPPLIED or orgs.keys().forall(o =>
    (o != familyOrg and not(HANDLERS.exists(h => handlers.get(h).stage != Free and handlers.get(h).org == o)))
      implies orgs.get(o).members == Set())

  val safety: bool = and { oneFamilyId, noStrayRandomId, oneOrganizationPerEvent, onlyFirstCreates, onlyFamilyOrgHasAdmins }

  /**
   * What keeps liveness possible. A core given the stored id, or none, can still start; and a
   * registration event, once recorded as processed, is being handled or has done its work (fixed:
   * the Family has an organization; supplied: its Family is pending delivery or delivered), since
   * the Identity Provider's later deliveries of it are ignored.
   */
  val coreCanStart: bool = CORES.forall(c => not(refuses(GIVEN.get(c), db.familyId)))
  val eventCanFinish: bool = USERS.forall(u =>
    (db.processed.contains(u) and not(handling(u))) implies
      (if (SUPPLIED) deliveries.exists(d => d.user == u) or ghost.familiesOf.get(u) != Set() else familyOrg != 0))

  val progress: bool = coreCanStart and eventCanFinish

  // ---- Witnesses ------------------------------------------------------------------------------

  val coreUp: bool = CORES.exists(c => cores.get(c).phase == Up)
  val allUp: bool = CORES.forall(c => cores.get(c).phase == Up)
  val coreRefused: bool = CORES.exists(c => cores.get(c).phase == Refused)
  val crashedWhilePreparing: bool = ghost.lastAction == DidCrashCore
  val familyWithAdmin: bool =
    if (SUPPLIED) families != Set() else familyOrg != 0 and orgs.get(familyOrg).members != Set()
  val registrationClosed: bool = not(signUpOpen)
  val lostTheRace: bool = ghost.lastAction == DidRemove
  val redelivered: bool = ghost.lastAction == DidReceive and HANDLERS.forall(h => handlers.get(h).stage == Free)
  val throwsWitness: bool = ghost.lastAction == DidFail
  val crashed: bool = ghost.lastAction == DidCrash
}
