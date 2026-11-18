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
// The Identity Provider (Logto) delivers a `PostRegister` once and never retries it, whatever the
// core answers; the network may still deliver it twice, to two replicas at once. In supplied mode the
// platform's central sign-in has the core run `PostRegister` again whenever a user signs in with no
// organization (artkoenig/family-agenda-cloud#125): the only way a missed event comes again.
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
//   signUp    a user registers in the Identity Provider while sign-up is open: one delivery
//   duplicate the network delivers an event again, maybe to another replica at once
//   signIn    (supplied) the central sign-in of a user in no organization: `PostRegister` once more
//   invite    (supplied) a user becomes an Admin of another Family through an invitation
//   deleteUser the user's account is deleted (a DSGVO request); Logto drops their memberships
//   receive   ProcessedEventRepository.recordIfNew, then isOpen (fixed mode: no organization yet);
//             with ACCOUNT_CHECKS (supplied, #467) also: the user still exists and is in no organization
//   create    IdentityDirectory.createOrganization, with the Family id (supplied mode: a new one)
//   addMember IdentityDirectory.addMember; it throws for a deleted user
//   record    (fixed) FamilyRepository.recordOrganizationId; the loser goes on to removeMember
//   remove    (fixed) IdentityDirectory.removeMember
//   close     (fixed) IdentityDirectory.closeRegistration, then the answer 204
//   send      (supplied) FamilyCreatedDeliveryRepository.add, then the answer 204
//   deliver   (supplied) a `family.created` delivery the platform takes, supplying the Family's Context
//   throws    a call that throws: processedEvents.forget, the answer 500
//   crash     a handler's core dies mid-way: nothing forgotten, no answer
//
// Left out: the signature and an unverified email (an ignored event, answered 204 as one seen before);
// wasInvited (an invitee here is one who joined an organization, which ACCOUNT_CHECKS covers); the
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
  /**
   * Whether a supplied registration first checks that the user still exists and is in no
   * organization (#467). False is the code as it is.
   */
  const ACCOUNT_CHECKS: bool
  /**
   * The proposed design: a delivery is only stored, as a row with the Family id it will get, and
   * answered 204; workers take a row under a lease and carry its registration to the end, noting on
   * the row the organization it created, so that a retry goes on where the last one stopped. Fixed
   * mode, one registration at a time. False is the code as it is.
   */
  const INBOX: bool
  /** (INBOX) A sweep deletes organizations without members that no registration under way names. */
  const SWEEP: bool
  /** (INBOX) Before creating, a registration looks for an organization holding its Family id. */
  const LOOKUP: bool
  /** Bound the organizations created, the ids drawn and the deliveries of events, so that the state space is finite. */
  const MAX_ORGS: int
  const MAX_DRAWS: int
  const MAX_EVENTS: int
  /** Bounds the faults of a trace (crashes, calls that throw, deleted users), so that random traces get deep. */
  const MAX_FAULTS: int

  // ---- State ----------------------------------------------------------------------------------

  type Phase = Down | Locked | Migrating | Migrated | Up | Refused

  /** A core preparing the database; `familyId` the id it serves once Up. */
  type Core = { phase: Phase, drawn: int, familyId: int }

  /**
   * The core's database: migrated, `family.family_id` (0: no row yet), `organization_id`,
   * `processed_idp_event`, and (INBOX) the stored registrations, in supplied mode in the
   * registration database.
   */
  type Db = { migrated: bool, familyId: int, organizationId: int, processed: Set[str], regs: str -> Reg }

  /** An organization in the Identity Provider, with the Family id in its customData; `gone` once deleted. */
  type Org = { familyId: int, members: Set[str], gone: bool }

  /**
   * (INBOX) A stored registration: the Family id it gets (supplied: drawn when stored), the
   * organization noted for it, whether it is done.
   */
  type Reg = { stored: bool, familyId: int, org: int, done: bool }

  /**
   * The Identity Provider: whether sign-up is open, the users with an account, the `PostRegister`
   * deliveries of each user under way, the organizations.
   */
  type Idp = { signUpOpen: bool, accounts: Set[str], inFlight: str -> int, orgs: int -> Org }

  type Stage = Free | ToCheck | ToCreate | ToNote | ToAddMember | ToRecord | ToRemove | ToClose | ToSend

  /** A delivery of the webhook being handled; `org` and `familyId` what it created so far. */
  type Handler = { stage: Stage, user: str, org: int, familyId: int }

  /** A pending `family.created` delivery (supplied mode). */
  type Delivery = { familyId: int, org: int, user: str }

  /** The platform: the pending `family.created` deliveries, and the Families whose Context it supplies. */
  type Platform = { deliveries: Set[Delivery], families: Set[int] }

  type Did =
    | DidInit | DidLock | DidCheck | DidDraw | DidCommit | DidWriteId | DidCrashCore | DidSignUp
    | DidDuplicate | DidSignIn | DidInvite | DidDeleteUser | DidReceive | DidSkip | DidCreate | DidAddMember
    | DidRecord | DidRemove | DidClose | DidSend | DidDeliver | DidThrow | DidCrash
    | DidAccept | DidTake | DidDone | DidLookUp | DidNote | DidSweep

  /**
   * Ghost state: the last action; every Family id the database ever held; the organizations each
   * user's registration created; the Families the platform was told of per user; the users who
   * registered; the deliveries of events so far.
   */
  type Ghost = {
    lastAction: Did,
    familyIds: Set[int],
    orgsOf: str -> int,
    familiesOf: str -> Set[int],
    registered: Set[str],
    events: int,
    faults: int,
  }

  var cores: str -> Core
  var lockHolder: str
  var db: Db
  var draws: int
  var idp: Idp
  var handlers: int -> Handler
  var platform: Platform
  var ghost: Ghost

  // ---- Functional logic -----------------------------------------------------------------------

  val noReg: Reg = { stored: false, familyId: 0, org: 0, done: false }
  val noHandler: Handler = { stage: Free, user: "", org: 0, familyId: 0 }
  val GIVEN_IDS: Set[int] = CORES.map(c => GIVEN.get(c)).exclude(Set(0))

  /** A random id, never one given: drawn ids count from 100. */
  pure def randomId(n: int): int = 100 + n

  /** migrateFamily's refusal: a given id that differs from the one stored. */
  pure def refuses(given: int, stored: int): bool = given != 0 and stored != 0 and stored != given

  /** The id the migrations' transaction leaves in the row: the given one when written inside it. */
  pure def committedId(given: int, drawn: int, inMigration: bool): int =
    if (inMigration and given != 0) given else drawn

  /** The organizations `u` is a member of. */
  pure def orgsWith(i: Idp, u: str): Set[int] = i.orgs.keys().filter(o => not(i.orgs.get(o).gone) and i.orgs.get(o).members.contains(u))

  /** Logto deleting a user: the account and every membership go. */
  pure def withoutUser(i: Idp, u: str): Idp =
    { ...i, accounts: i.accounts.exclude(Set(u)), orgs: i.orgs.keys().mapBy(o => { ...i.orgs.get(o), members: i.orgs.get(o).members.exclude(Set(u)) }) }

  pure def withMember(i: Idp, o: int, u: str, member: bool): Idp = {
    val org = i.orgs.get(o)
    { ...i, orgs: i.orgs.set(o, { ...org, members: if (member) org.members.union(Set(u)) else org.members.exclude(Set(u)) }) }
  }

  /** #467's checks before creating anything: the user still exists and is in no organization. */
  pure def mayCreateFor(i: Idp, u: str): bool = i.accounts.contains(u) and orgsWith(i, u) == Set()

  /** One more delivery of `u`'s `PostRegister`. */
  pure def delivering(i: Idp, u: str): Idp = { ...i, inFlight: i.inFlight.setBy(u, n => n + 1) }

  /** Whether a handler is busy with `u`'s event, or with organization `o`. */
  def handling(u: str): bool = HANDLERS.exists(h => handlers.get(h).stage != Free and handlers.get(h).user == u)
  def handlingOrg(o: int): bool = HANDLERS.exists(h => handlers.get(h).stage != Free and handlers.get(h).org == o)

  /** The organization recorded as the Family's, in fixed mode. */
  def familyOrg: int = db.organizationId

  /** Whether a Family of `o` reaches the platform (supplied mode). */
  def familyComes(o: int): bool =
    platform.families.contains(idp.orgs.get(o).familyId) or platform.deliveries.exists(d => d.org == o)

  // ---- State machine: preparing ---------------------------------------------------------------

  action did(name: Did): bool = ghost' = { ...ghost, lastAction: name }
  /** A fault, counted against MAX_FAULTS. */
  action fault(name: Did): bool = all { ghost.faults < MAX_FAULTS, ghost' = { ...ghost, lastAction: name, faults: ghost.faults + 1 } }

  action keepRegistration: bool = all { idp' = idp, handlers' = handlers, platform' = platform }
  action keepPreparing: bool = all { cores' = cores, lockHolder' = lockHolder, draws' = draws }

  action init = all {
    cores' = CORES.mapBy(_ => { phase: Down, drawn: 0, familyId: 0 }),
    lockHolder' = "",
    db' = { migrated: false, familyId: 0, organizationId: 0, processed: Set(), regs: USERS.mapBy(_ => noReg) },
    draws' = 0,
    idp' = { signUpOpen: true, accounts: Set(), inFlight: USERS.mapBy(_ => 0), orgs: Map() },
    handlers' = HANDLERS.mapBy(_ => noHandler),
    platform' = { deliveries: Set(), families: Set() },
    ghost' = {
      lastAction: DidInit, familyIds: Set(), orgsOf: USERS.mapBy(_ => 0), familiesOf: USERS.mapBy(_ => Set()),
      registered: Set(), events: 0, faults: 0,
    },
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
    db' = db, draws' = draws, keepRegistration, fault(DidCrashCore),
  }

  // ---- State machine: the Identity Provider and the platform ----------------------------------

  /** Whether a core serves the webhook: in fixed mode one that prepared the Family. */
  val serving: bool = SUPPLIED or CORES.exists(c => cores.get(c).phase == Up)

  /** Changes only the Identity Provider (and the ghost). */
  action idpOnly(changed: Idp, name: Did, events: int): bool = all {
    idp' = changed, handlers' = handlers, platform' = platform, db' = db, keepPreparing,
    ghost' = { ...ghost, lastAction: name, events: ghost.events + events, registered: ghost.registered.union(changed.accounts) },
  }

  /** A user registers while sign-up is open; Logto delivers the event once. */
  action signUp(u: str): bool = all {
    idp.signUpOpen, not(ghost.registered.contains(u)), ghost.events < MAX_EVENTS,
    idpOnly(delivering({ ...idp, accounts: idp.accounts.union(Set(u)) }, u), DidSignUp, 1),
  }

  /** The network delivers an event again, maybe to another replica while the first is handled. */
  action duplicate(u: str): bool = all {
    idp.inFlight.get(u) > 0, ghost.events < MAX_EVENTS,
    idpOnly(delivering(idp, u), DidDuplicate, 1),
  }

  /** The central sign-in of a user in no organization runs `PostRegister` again (supplied mode). */
  action signIn(u: str): bool = all {
    SUPPLIED, idp.accounts.contains(u), orgsWith(idp, u) == Set(), idp.inFlight.get(u) == 0, ghost.events < MAX_EVENTS,
    idpOnly(delivering(idp, u), DidSignIn, 1),
  }

  /** A user accepts an invitation to an organization with Admins (supplied mode). */
  action invite(u: str, o: int): bool = all {
    SUPPLIED, idp.accounts.contains(u), idp.orgs.keys().contains(o), not(idp.orgs.get(o).gone), idp.orgs.get(o).members != Set(),
    not(idp.orgs.get(o).members.contains(u)),
    idpOnly(withMember(idp, o, u, true), DidInvite, 0),
  }

  action deleteUser(u: str): bool = all {
    idp.accounts.contains(u), ghost.faults < MAX_FAULTS,
    idp' = withoutUser(idp, u), handlers' = handlers, platform' = platform, db' = db, keepPreparing,
    ghost' = { ...ghost, lastAction: DidDeleteUser, faults: ghost.faults + 1 },
  }

  /** The platform takes a `family.created` delivery and supplies the Family's Context. */
  action deliver(d: Delivery): bool = all {
    platform.deliveries.contains(d),
    platform' = { deliveries: platform.deliveries.exclude(Set(d)), families: platform.families.union(Set(d.familyId)) },
    db' = db, keepPreparing, idp' = idp, handlers' = handlers,
    ghost' = { ...ghost, lastAction: DidDeliver, familiesOf: ghost.familiesOf.setBy(d.user, f => f.union(Set(d.familyId))) },
  }

  // ---- State machine: the core's registration -------------------------------------------------

  action setHandler(h: int, handler: Handler): bool = handlers' = handlers.set(h, handler)

  /**
   * A delivery reaches a replica. recordIfNew: one seen before is ignored (204). Fixed mode, a
   * Family with an organization only closes again. With ACCOUNT_CHECKS, a supplied registration of a
   * deleted user or of a member of an organization creates nothing (204).
   */
  action receive(h: int, u: str): bool = {
    val skips = db.processed.contains(u) or (SUPPLIED and ACCOUNT_CHECKS and not(mayCreateFor(idp, u)))
    all {
      not(INBOX), serving, handlers.get(h).stage == Free, idp.inFlight.get(u) > 0,
      idp' = { ...idp, inFlight: idp.inFlight.setBy(u, n => n - 1) },
      db' = { ...db, processed: db.processed.union(Set(u)) },
      setHandler(h, if (skips) noHandler
        else { ...noHandler, user: u, stage: if (not(SUPPLIED) and familyOrg != 0) ToClose else ToCreate }),
      platform' = platform, keepPreparing, did(if (skips) DidSkip else DidReceive),
    }
  }

  /** createOrganization, with the Family's id, or in supplied mode a new random one. */
  action create(h: int): bool = {
    val handler = handlers.get(h)
    val drawsAnew = SUPPLIED and not(INBOX)
    val familyId = if (INBOX) handler.familyId else if (SUPPLIED) randomId(draws + 1) else db.familyId
    val org = idp.orgs.keys().size() + 1
    all {
      handler.stage == ToCreate, org <= MAX_ORGS, not(drawsAnew) or draws < MAX_DRAWS,
      idp' = { ...idp, orgs: idp.orgs.put(org, { familyId: familyId, members: Set(), gone: false }) },
      setHandler(h, { ...handler, stage: if (INBOX) ToNote else ToAddMember, org: org, familyId: familyId }),
      draws' = if (drawsAnew) draws + 1 else draws,
      cores' = cores, lockHolder' = lockHolder, db' = db, platform' = platform,
      ghost' = { ...ghost, lastAction: DidCreate, orgsOf: ghost.orgsOf.setBy(handler.user, n => n + 1) },
    }
  }

  /** addMember; for a deleted user it throws instead. */
  action addMember(h: int): bool = {
    val handler = handlers.get(h)
    all {
      handler.stage == ToAddMember, idp.accounts.contains(handler.user),
      idp' = withMember(idp, handler.org, handler.user, true),
      setHandler(h, { ...handler, stage: if (SUPPLIED) ToSend else ToRecord }),
      db' = db, keepPreparing, platform' = platform, did(DidAddMember),
    }
  }

  /** recordOrganizationId: the first organization recorded is the Family's; the loser removes its member. */
  action record(h: int): bool = {
    val handler = handlers.get(h)
    all {
      handler.stage == ToRecord,
      db' = if (db.organizationId == 0) { ...db, organizationId: handler.org } else db,
      setHandler(h, { ...handler, stage: if (db.organizationId == 0 or db.organizationId == handler.org) ToClose else ToRemove }),
      keepPreparing, idp' = idp, platform' = platform, did(DidRecord),
    }
  }

  action remove(h: int): bool = {
    val handler = handlers.get(h)
    all {
      handler.stage == ToRemove,
      idp' = withMember(idp, handler.org, handler.user, false),
      setHandler(h, { ...handler, stage: ToClose }),
      db' = db, keepPreparing, platform' = platform, did(DidRemove),
    }
  }

  /** closeRegistration, then the answer 204. */
  action close(h: int): bool = all {
    handlers.get(h).stage == ToClose,
    idp' = { ...idp, signUpOpen: false }, setHandler(h, noHandler),
    db' = doneFor(handlers.get(h).user), keepPreparing, platform' = platform, did(DidClose),
  }

  /** FamilyCreatedDeliveryRepository.add, then the answer 204. */
  action send(h: int): bool = {
    val handler = handlers.get(h)
    all {
      handler.stage == ToSend,
      platform' = { ...platform, deliveries: platform.deliveries.union(Set({ familyId: handler.familyId, org: handler.org, user: handler.user })) },
      setHandler(h, noHandler),
      db' = doneFor(handler.user), keepPreparing, idp' = idp, did(DidSend),
    }
  }

  /** A call that throws: the event is forgotten and answered 500, which Logto never retries. */
  action throws(h: int): bool = all {
    handlers.get(h).stage != Free,
    db' = if (INBOX) db else { ...db, processed: db.processed.exclude(Set(handlers.get(h).user)) },
    setHandler(h, noHandler),
    keepPreparing, idp' = idp, platform' = platform, fault(DidThrow),
  }

  /** The handler's core dies: nothing is forgotten, no answer. */
  action crash(h: int): bool = all {
    handlers.get(h).stage != Free,
    setHandler(h, noHandler),
    db' = db, keepPreparing, idp' = idp, platform' = platform, fault(DidCrash),
  }

  // ---- State machine: the proposed design (INBOX) ---------------------------------------------

  /** (INBOX) The registration of `u` done, if one is stored. */
  def doneFor(u: str): Db =
    if (INBOX) { ...db, regs: db.regs.setBy(u, r => { ...r, done: true }) } else db

  /** A delivery reaches a replica, which stores the registration once (supplied: with a new Family id) and answers 204. */
  action accept(u: str): bool = {
    val drawsAnew = SUPPLIED and not(db.regs.get(u).stored)
    all {
      INBOX, serving, idp.inFlight.get(u) > 0, not(drawsAnew) or draws < MAX_DRAWS,
      idp' = { ...idp, inFlight: idp.inFlight.setBy(u, n => n - 1) },
      db' = if (db.regs.get(u).stored) db
        else { ...db, regs: db.regs.set(u, { ...noReg, stored: true, familyId: if (SUPPLIED) randomId(draws + 1) else db.familyId }) },
      draws' = if (drawsAnew) draws + 1 else draws,
      cores' = cores, lockHolder' = lockHolder, handlers' = handlers, platform' = platform, did(DidAccept),
    }
  }

  /**
   * A worker takes a registration not done under a lease, which nobody else holds; a core dying
   * lets it expire. Fixed mode, while no other registration is under way.
   */
  action take(h: int, u: str): bool = {
    val reg = db.regs.get(u)
    all {
      INBOX, handlers.get(h).stage == Free, reg.stored, not(reg.done), not(handling(u)),
      SUPPLIED or HANDLERS.forall(g => handlers.get(g).stage == Free),
      setHandler(h, { stage: ToCheck, user: u, org: reg.org, familyId: reg.familyId }),
      db' = db, keepPreparing, idp' = idp, platform' = platform, did(DidTake),
    }
  }

  /** The organization holding the Family id `familyId`, if any (LOOKUP); 0 for none. */
  def orgOf(familyId: int): int = {
    val found = idp.orgs.keys().filter(o => not(idp.orgs.get(o).gone) and idp.orgs.get(o).familyId == familyId)
    if (found == Set()) 0 else found.fold(MAX_ORGS + 1, (a, b) => if (a < b) a else b)
  }

  /**
   * Where the registration goes on: a deleted user or a member of another organization gets
   * nothing (done); fixed mode, a Family with another organization only closes again; the
   * organization noted, or (LOOKUP) found by the Family id, gets its member; otherwise one is created.
   */
  action checkReg(h: int): bool = {
    val handler = handlers.get(h)
    val u = handler.user
    val found = if (handler.org == 0 and LOOKUP) orgOf(handler.familyId) else 0
    val nothing = not(idp.accounts.contains(u)) or orgsWith(idp, u).exists(o => o != handler.org)
    all {
      handler.stage == ToCheck,
      if (nothing) all { setHandler(h, noHandler), db' = doneFor(u) }
      else if (not(SUPPLIED) and familyOrg != 0 and familyOrg != handler.org) all { setHandler(h, { ...handler, stage: ToClose }), db' = db }
      else if (handler.org != 0) all { setHandler(h, { ...handler, stage: ToAddMember }), db' = db }
      else if (found != 0) all {
        setHandler(h, { ...handler, stage: ToAddMember, org: found }),
        db' = { ...db, regs: db.regs.setBy(u, r => { ...r, org: found }) },
      }
      else all { setHandler(h, { ...handler, stage: ToCreate }), db' = db },
      keepPreparing, idp' = idp, platform' = platform,
      did(if (nothing) DidDone else if (found != 0) DidLookUp else DidCheck),
    }
  }

  /** The organization just created noted on the registration's row. */
  action note(h: int): bool = {
    val handler = handlers.get(h)
    all {
      handler.stage == ToNote,
      db' = { ...db, regs: db.regs.setBy(handler.user, r => { ...r, org: handler.org }) },
      setHandler(h, { ...handler, stage: ToAddMember }),
      keepPreparing, idp' = idp, platform' = platform, did(DidNote),
    }
  }

  /**
   * (SWEEP) Deletes an organization without members that no registration under way names. The code
   * would tell them apart by age, longer than any registration's lease; the model by the state.
   */
  action sweep(o: int): bool = all {
    SWEEP, idp.orgs.keys().contains(o), not(idp.orgs.get(o).gone), idp.orgs.get(o).members == Set(),
    not(handlingOrg(o)), not(USERS.exists(u => db.regs.get(u).org == o and not(db.regs.get(u).done))),
    idp' = { ...idp, orgs: idp.orgs.setBy(o, org => { ...org, gone: true }) },
    db' = db, keepPreparing, handlers' = handlers, platform' = platform, did(DidSweep),
  }

  action step = any {
    nondet c = CORES.oneOf()
    any { lock(c), check(c), draw(c), commit(c), writeId(c), crashCore(c) },
    nondet u = USERS.oneOf()
    nondet o = 1.to(MAX_ORGS).oneOf()
    any { signUp(u), duplicate(u), signIn(u), invite(u, o), deleteUser(u) },
    nondet h = HANDLERS.oneOf()
    nondet u = USERS.oneOf()
    any { receive(h, u), accept(u), take(h, u), checkReg(h), note(h), create(h), addMember(h), record(h), remove(h), close(h), send(h), throws(h), crash(h) },
    nondet o = 1.to(MAX_ORGS).oneOf()
    sweep(o),
    nondet d = platform.deliveries.union(Set({ familyId: 0, org: 0, user: "" })).oneOf()
    deliver(d),
  }

  // ---- Properties -----------------------------------------------------------------------------

  /** The database only ever holds one Family id, and every core serves that one. */
  val oneFamilyId: bool =
    ghost.familyIds.size() <= 1 and CORES.forall(c => cores.get(c).phase == Up implies cores.get(c).familyId == db.familyId)
  /** A failed start leaves no random id behind: a database given an id holds that id or none. */
  val noStrayRandomId: bool = GIVEN_IDS.size() != 1 or db.familyId == 0 or GIVEN_IDS.contains(db.familyId)
  /** One user's registration creates at most one organization, and the platform learns of at most one Family. */
  val oneOrganizationPerEvent: bool = USERS.forall(u => ghost.orgsOf.get(u) <= 1 and ghost.familiesOf.get(u).size() <= 1)
  /** Self-hosted, only the first registration creates anything: one organization at most. */
  val onlyFirstCreates: bool = SUPPLIED or idp.orgs.keys().size() <= 1
  /** Self-hosted, an Admin is a member of the Family's organization and of no other. */
  val onlyFamilyOrgHasAdmins: bool = SUPPLIED or idp.orgs.keys().forall(o =>
    (o != familyOrg and not(handlingOrg(o)) and not(idp.orgs.get(o).gone)) implies idp.orgs.get(o).members == Set())
  /** Supplied, a person is an Admin of at most one Family (#467: registrationMakesOneFamily). */
  val oneFamilyPerAdmin: bool = not(SUPPLIED) or USERS.forall(u => orgsWith(idp, u).filter(o => not(handlingOrg(o))).size() <= 1)
  /**
   * An organization left without members: not deleted, and no registration under way, running or
   * stored, will add one (#467's debris).
   */
  def leftEmpty(o: int): bool =
    not(idp.orgs.get(o).gone) and idp.orgs.get(o).members == Set() and not(handlingOrg(o))
      and not(USERS.exists(u => db.regs.get(u).org == o and not(db.regs.get(u).done)))
  /**
   * No organization is left empty; with SWEEP, every one left empty can be deleted (the sweep is
   * enabled for it, and the scenarios show it deleted).
   */
  val noEmptyOrganization: bool = SWEEP or idp.orgs.keys().forall(o => not(leftEmpty(o)))

  val registrationSafety: bool = and { oneOrganizationPerEvent, onlyFirstCreates, onlyFamilyOrgHasAdmins, oneFamilyPerAdmin, noEmptyOrganization }
  val safety: bool = and { oneFamilyId, noStrayRandomId, registrationSafety }

  /** A core given the stored id, or none, can still start. */
  val coreCanStart: bool = CORES.forall(c => not(refuses(GIVEN.get(c), db.familyId)))

  /**
   * What keeps liveness possible: a user who registered and still has an account gets to a Family
   * with them as its Admin, or is on the way there: a delivery or a handler is under way, or
   * (supplied) the central sign-in will run `PostRegister` again and it will not be ignored.
   * Fixed mode, any Admin of the Family will do.
   */
  def onTheWay(u: str): bool =
    idp.inFlight.get(u) > 0 or handling(u) or (db.regs.get(u).stored and not(db.regs.get(u).done))
  def reachesFamily(u: str): bool =
    if (SUPPLIED) orgsWith(idp, u).exists(o => familyComes(o)) or (not(INBOX) and orgsWith(idp, u) == Set() and not(db.processed.contains(u)))
    else familyOrg != 0 and idp.orgs.get(familyOrg).members != Set()
  val eventCanFinish: bool = USERS.forall(u =>
    (ghost.registered.contains(u) and idp.accounts.contains(u)) implies (onTheWay(u) or reachesFamily(u)))

  val progress: bool = coreCanStart and eventCanFinish

  // ---- Witnesses ------------------------------------------------------------------------------

  val coreUp: bool = CORES.exists(c => cores.get(c).phase == Up)
  val allUp: bool = CORES.forall(c => cores.get(c).phase == Up)
  val coreRefused: bool = CORES.exists(c => cores.get(c).phase == Refused)
  val crashedWhilePreparing: bool = ghost.lastAction == DidCrashCore
  val familyWithAdmin: bool =
    if (SUPPLIED) platform.families != Set() else familyOrg != 0 and idp.orgs.get(familyOrg).members != Set()
  val registrationClosed: bool = not(idp.signUpOpen)
  val lostTheRace: bool = ghost.lastAction == DidRemove
  val duplicated: bool = ghost.lastAction == DidDuplicate
  val skipped: bool = ghost.lastAction == DidSkip
  val signedInAgain: bool = ghost.lastAction == DidSignIn
  val invited: bool = ghost.lastAction == DidInvite
  val userDeleted: bool = ghost.lastAction == DidDeleteUser
  val throwsWitness: bool = ghost.lastAction == DidThrow
  val crashed: bool = ghost.lastAction == DidCrash
  val noted: bool = ghost.lastAction == DidNote
  val lookedUp: bool = ghost.lastAction == DidLookUp
  val swept: bool = ghost.lastAction == DidSweep
  val doneWithNothing: bool = ghost.lastAction == DidDone
}
