// Migrations described for the rolling-update spec (rollingUpdate.qnt). Each is a list of releases,
// oldest first, and the datum each column holds; rollingUpdate_test.qnt checks each as an instance.
// Columns are named "table.column" as in packages/adapters/drizzle/.
module migrations {
  import rollingUpdate.* from "./rollingUpdate"

  pure val noMigration: Migration = { adds: Set(), copies: Set(), drops: Set() }

  // ---- 0016_admin_session_id_token: expand only ------------------------------------------------
  // A nullable column the release before neither reads nor writes; the new code writes the ID token
  // at sign-in and reads it at sign-out.

  pure val idTokenData: Col -> Datum = Map(
    "admin_session.id" -> "sessionId",
    "admin_session.id_token" -> "idToken",
  )
  pure val idTokenReleases: List[Release] = List(
    { reads: Map("sessionId" -> "admin_session.id"),
      writes: Map("sessionId" -> Set("admin_session.id")),
      migration: { ...noMigration, adds: Set("admin_session.id") } },
    { reads: Map("sessionId" -> "admin_session.id", "idToken" -> "admin_session.id_token"),
      writes: Map("sessionId" -> Set("admin_session.id"), "idToken" -> Set("admin_session.id_token")),
      migration: { ...noMigration, adds: Set("admin_session.id_token") } },
  )

  // ---- 0009_family_id, as shipped: a rename in one step ----------------------------------------
  // `family.public_id` renamed to `family.family_id` in one migration: contract before the cores of
  // the release before are gone. ADR-0003 names it as predating the rule; the spec must reject it.
  // Opening reads the Family id (`family-id-differs`); only preparing an empty database writes it.

  pure val familyIdData: Col -> Datum = Map(
    "family.public_id" -> "familyId",
    "family.family_id" -> "familyId",
  )
  pure val familyIdShipped: List[Release] = List(
    { reads: Map("familyId" -> "family.public_id"), writes: Map(),
      migration: { ...noMigration, adds: Set("family.public_id") } },
    { reads: Map("familyId" -> "family.family_id"), writes: Map(),
      migration: { adds: Set("family.family_id"),
                   copies: Set(("family.public_id", "family.family_id")),
                   drops: Set("family.public_id") } },
  )

  // ---- 0009_family_id, as the rule asks: add and copy, a release later drop --------------------

  pure val familyIdExpandContract: List[Release] = List(
    familyIdShipped[0],
    { reads: Map("familyId" -> "family.family_id"), writes: Map(),
      migration: { ...noMigration, adds: Set("family.family_id"),
                   copies: Set(("family.public_id", "family.family_id")) } },
    { reads: Map("familyId" -> "family.family_id"), writes: Map(),
      migration: { ...noMigration, drops: Set("family.public_id") } },
  )

  // ---- A rename of a column the old code writes ---------------------------------------------
  // Hypothetical: `member.colour` renamed to `member.color`. Each release may only stop using what
  // the release before no longer needs, and cores of the release before write on after each copy.
  // So the rename takes four releases after the old one (`colourRename`):
  //   1  adds and copies; writes both, reads the old column (release 0 writes only the old one)
  //   2  copies again, now that no core writes only the old column; writes both, reads the new one
  //   3  reads and writes only the new column (release 2 still writes both)
  //   4  drops the old column, which release 3 no longer uses
  // `colourRenameHasty` is the rename in three: release 1 writes and reads the new column, so a
  // write of release 0 after the copy is lost to it.

  pure val colourData: Col -> Datum = Map("member.colour" -> "colour", "member.color" -> "colour")
  pure val copyColour: Set[(Col, Col)] = Set(("member.colour", "member.color"))
  pure val readOld: Datum -> Col = Map("colour" -> "member.colour")
  pure val readNew: Datum -> Col = Map("colour" -> "member.color")
  pure val writeOld: Datum -> Set[Col] = Map("colour" -> Set("member.colour"))
  pure val writeNew: Datum -> Set[Col] = Map("colour" -> Set("member.color"))
  pure val writeBoth: Datum -> Set[Col] = Map("colour" -> Set("member.colour", "member.color"))

  pure val colourRename: List[Release] = List(
    { reads: readOld, writes: writeOld, migration: { ...noMigration, adds: Set("member.colour") } },
    { reads: readOld, writes: writeBoth, migration: { ...noMigration, adds: Set("member.color"), copies: copyColour } },
    { reads: readNew, writes: writeBoth, migration: { ...noMigration, copies: copyColour } },
    { reads: readNew, writes: writeNew, migration: noMigration },
    { reads: readNew, writes: writeNew, migration: { ...noMigration, drops: Set("member.colour") } },
  )
  pure val colourRenameHasty: List[Release] = List(
    colourRename[0],
    { reads: readNew, writes: writeNew, migration: { ...noMigration, adds: Set("member.color"), copies: copyColour } },
    colourRename[4],
  )
}
