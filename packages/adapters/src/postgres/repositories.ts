import type {
  ActivityKind,
  ActivityRepository,
  AdminRepository,
  AdminSession,
  AdminSessionRepository,
  BackgroundActivity,
  CatalogueRecord,
  CatalogueRepository,
  DeclaredAttribute,
  FamilyMemberRepository,
  FamilyRepository,
  IdentityProviderRepository,
  SoleAssignment,
  LlmEndpointRepository,
  PlainConfig,
  SecretRef,
  SignInFailureLog,
  Source,
  SourceAttribute,
  SourceRepository,
  SourceTypeRecord,
  SourceTypeRepository,
  StoredIdentityProvider,
  StoredLlmEndpoint,
  AgendaRepository,
} from "@family-agenda/application";
import type {
  Admin,
  AdminId,
  BlobRef,
  Email,
  FamilyLanguages,
  FamilyMember,
  FamilyMemberId,
  OcrLanguage,
  PhotoType,
  RunError,
  SourceAttributeId,
  SourceFailure,
  SourceId,
  SourceTypeId,
  Agenda,
  AgendaId,
  AgendaLayout,
} from "@family-agenda/domain";
import { defaultFamilyLanguage, isFamilyLanguage } from "@family-agenda/domain";
import { and, asc, eq, gt, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import { uuidPattern } from "../uuid";
import type { Database } from "./database";
import {
  admins,
  adminSessions,
  backgroundActivities,
  catalogueEntries,
  family,
  familyMembers,
  identityProviders,
  llmEndpoints,
  signInFailures,
  sourceAttributeMembers,
  sourceAttributes,
  sourceRecordAttachments,
  sourceRecords,
  sourceRuns,
  sources,
  sourceTypes,
  agendaMembers,
  agendas,
} from "./schema";

/** Arbitrary key that serialises creating the first Admin. */
const setupLockKey = 7_342_002;

/** Reads and writes the one row of `family`, which the schema creates (ADR-0013). */
export class PostgresFamilyRepository implements FamilyRepository {
  constructor(private readonly db: Database) {}

  async recoveryKitConfirmed(): Promise<boolean> {
    const [row] = await this.db.select({ at: family.recoveryKitConfirmedAt }).from(family);
    return row?.at != null;
  }

  async confirmRecoveryKit(at: Date): Promise<void> {
    await this.db
      .update(family)
      .set({ recoveryKitConfirmedAt: sql`coalesce(${family.recoveryKitConfirmedAt}, ${at})` });
  }

  async languages(): Promise<FamilyLanguages> {
    const [row] = await this.db
      .select({ language: family.language, ocrLanguages: family.ocrLanguages })
      .from(family);
    if (!row) throw new Error("the family row is missing");
    return {
      language: isFamilyLanguage(row.language) ? row.language : defaultFamilyLanguage,
      ocrLanguages: row.ocrLanguages as OcrLanguage[],
    };
  }

  async saveLanguages(languages: FamilyLanguages): Promise<void> {
    await this.db.update(family).set({ language: languages.language, ocrLanguages: languages.ocrLanguages });
  }

  async ocrEnabled(): Promise<boolean> {
    const [row] = await this.db.select({ ocrEnabled: family.ocrEnabled }).from(family);
    if (!row) throw new Error("the family row is missing");
    return row.ocrEnabled;
  }

  async saveOcrEnabled(enabled: boolean): Promise<void> {
    await this.db.update(family).set({ ocrEnabled: enabled });
  }
}

export class PostgresAdminRepository implements AdminRepository {
  constructor(private readonly db: Database) {}

  async exists(): Promise<boolean> {
    const [row] = await this.db.select({ id: admins.id }).from(admins).limit(1);
    return row !== undefined;
  }

  async addFirst(admin: Admin): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${setupLockKey})`);
      const [existing] = await tx.select({ id: admins.id }).from(admins).limit(1);
      if (existing) return false;
      await tx.insert(admins).values(admin);
      return true;
    });
  }

  async add(admin: Admin): Promise<boolean> {
    const inserted = await this.db
      .insert(admins)
      .values(admin)
      .onConflictDoNothing({ target: admins.email })
      .returning({ id: admins.id });
    return inserted.length === 1;
  }

  async findById(id: AdminId): Promise<Admin | null> {
    if (!uuidPattern.test(id)) return null;
    const [row] = await this.db.select().from(admins).where(eq(admins.id, id));
    return row ? toAdmin(row) : null;
  }

  async findByEmail(email: Email): Promise<Admin | null> {
    const [row] = await this.db.select().from(admins).where(eq(admins.email, email));
    return row ? toAdmin(row) : null;
  }

  async findByIdentitySubject(subject: string): Promise<Admin | null> {
    const [row] = await this.db
      .select()
      .from(admins)
      .where(eq(admins.identitySubject, subject));
    return row ? toAdmin(row) : null;
  }

  async setIdentitySubject(id: AdminId, subject: string): Promise<void> {
    await this.db
      .update(admins)
      .set({ identitySubject: subject })
      .where(eq(admins.id, id));
  }

  async list(): Promise<Admin[]> {
    const rows = await this.db
      .select()
      .from(admins)
      .orderBy(asc(admins.createdAt), asc(admins.email));
    return rows.map(toAdmin);
  }

  async setPasswordHash(id: AdminId, passwordHash: string): Promise<void> {
    await this.db.update(admins).set({ passwordHash }).where(eq(admins.id, id));
  }
}

function toAdmin(row: typeof admins.$inferSelect): Admin {
  return {
    id: row.id as AdminId,
    email: row.email as Email,
    passwordHash: row.passwordHash,
    identitySubject: row.identitySubject,
    createdAt: row.createdAt,
  };
}

export class PostgresAdminSessionRepository implements AdminSessionRepository {
  constructor(private readonly db: Database) {}

  async add(session: AdminSession): Promise<void> {
    await this.db.insert(adminSessions).values(session);
  }

  async find(id: string): Promise<AdminSession | null> {
    const [row] = await this.db.select().from(adminSessions).where(eq(adminSessions.id, id));
    return row ? { id: row.id, adminId: row.adminId as AdminId, expiresAt: row.expiresAt } : null;
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(adminSessions).where(eq(adminSessions.id, id));
  }

  async removeAllOf(adminId: AdminId): Promise<void> {
    await this.db.delete(adminSessions).where(eq(adminSessions.adminId, adminId));
  }

  async removeExpired(now: Date): Promise<void> {
    await this.db.delete(adminSessions).where(lte(adminSessions.expiresAt, now));
  }
}

export class PostgresSignInFailureLog implements SignInFailureLog {
  constructor(
    private readonly db: Database,
    /** Failures older than this are deleted when new ones are recorded. */
    private readonly keepForMs: number,
  ) {}

  async record(keys: string[], at: Date): Promise<string[]> {
    const rows = await this.db
      .insert(signInFailures)
      .values(keys.map((key) => ({ key, at })))
      .returning({ id: signInFailures.id });
    await this.db
      .delete(signInFailures)
      .where(lt(signInFailures.at, new Date(at.getTime() - this.keepForMs)));
    return rows.map((row) => String(row.id));
  }

  async forget(ids: string[]): Promise<void> {
    await this.db.delete(signInFailures).where(inArray(signInFailures.id, ids.map(Number)));
  }

  async countAfter(key: string, after: Date): Promise<number> {
    return this.db.$count(
      signInFailures,
      and(eq(signInFailures.key, key), gt(signInFailures.at, after)),
    );
  }

  async clear(key: string): Promise<void> {
    await this.db.delete(signInFailures).where(eq(signInFailures.key, key));
  }
}

export class PostgresFamilyMemberRepository implements FamilyMemberRepository {
  constructor(private readonly db: Database) {}

  async add(member: FamilyMember): Promise<void> {
    await this.db.insert(familyMembers).values({ ...member, ...photoColumns(member) });
  }

  async list(): Promise<FamilyMember[]> {
    const rows = await this.db.select().from(familyMembers).orderBy(asc(familyMembers.position));
    return rows.map(toFamilyMember);
  }

  async findById(id: FamilyMemberId): Promise<FamilyMember | null> {
    if (!uuidPattern.test(id)) return null;
    const [row] = await this.db.select().from(familyMembers).where(eq(familyMembers.id, id));
    return row ? toFamilyMember(row) : null;
  }

  async update(member: FamilyMember): Promise<void> {
    await this.db
      .update(familyMembers)
      .set({ name: member.name, ...photoColumns(member) })
      .where(eq(familyMembers.id, member.id));
  }

  async remove(id: FamilyMemberId): Promise<{ removed: true } | { removed: false; blocking: SoleAssignment[] }> {
    if (!uuidPattern.test(id)) return { removed: true };
    const blocking = await this.soleAssignments(id);
    if (blocking.length > 0) return { removed: false, blocking };
    // The trigger family_member_before_delete is what guarantees the rule; the check above only
    // names the Source Attributes. Should one be assigned to them alone in between, the trigger's
    // error surfaces as it is rather than as a message that names nothing.
    await this.db.delete(familyMembers).where(eq(familyMembers.id, id));
    return { removed: true };
  }

  /** The Source Attributes assigned to the Family Member and no one else. */
  private async soleAssignments(id: FamilyMemberId): Promise<SoleAssignment[]> {
    const rows = await this.db
      .select({ sourceId: sourceAttributes.sourceId, attribute: sourceAttributes.name })
      .from(sourceAttributeMembers)
      .innerJoin(sourceAttributes, eq(sourceAttributes.id, sourceAttributeMembers.attributeId))
      .innerJoin(sources, eq(sources.id, sourceAttributes.sourceId))
      .where(
        and(
          eq(sourceAttributeMembers.familyMemberId, id),
          sql`NOT EXISTS (SELECT 1 FROM ${sourceAttributeMembers} AS other WHERE other.attribute_id = ${sourceAttributeMembers.attributeId} AND other.family_member_id <> ${id})`,
        ),
      )
      .orderBy(asc(sources.position), asc(sourceAttributes.name));
    return rows.map((row) => ({ sourceId: row.sourceId as SourceId, attribute: row.attribute }));
  }
}

function toFamilyMember(row: typeof familyMembers.$inferSelect): FamilyMember {
  return {
    id: row.id as FamilyMemberId,
    name: row.name,
    photo:
      row.photoBlob && row.photoContentType
        ? { blob: row.photoBlob as BlobRef, contentType: row.photoContentType as PhotoType }
        : null,
    createdAt: row.createdAt,
  };
}

function photoColumns(member: FamilyMember) {
  return {
    photoBlob: member.photo?.blob ?? null,
    photoContentType: member.photo?.contentType ?? null,
  };
}

export class PostgresAgendaRepository implements AgendaRepository {
  constructor(private readonly db: Database) {}

  async add(agenda: Agenda): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(agendas).values(agenda);
      await insertMembers(tx, agenda);
    });
  }

  async list(): Promise<Agenda[]> {
    return this.select();
  }

  async findById(id: AgendaId): Promise<Agenda | null> {
    if (!uuidPattern.test(id)) return null;
    const [agenda] = await this.select(eq(agendas.id, id));
    return agenda ?? null;
  }

  async update(agenda: Agenda): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(agendas).set({ layout: agenda.layout, horizonDays: agenda.horizonDays }).where(eq(agendas.id, agenda.id));
      await tx.delete(agendaMembers).where(eq(agendaMembers.agendaId, agenda.id));
      await insertMembers(tx, agenda);
    });
  }

  async remove(id: AgendaId): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db.delete(agendas).where(eq(agendas.id, id));
  }

  private async select(where?: SQL): Promise<Agenda[]> {
    const rows = await this.db
      .select({ agenda: agendas, familyMemberId: agendaMembers.familyMemberId })
      .from(agendas)
      .leftJoin(agendaMembers, eq(agendaMembers.agendaId, agendas.id))
      .leftJoin(familyMembers, eq(familyMembers.id, agendaMembers.familyMemberId))
      .where(where)
      .orderBy(asc(agendas.position), asc(familyMembers.position));
    const byId = new Map<string, Agenda>();
    for (const { agenda, familyMemberId } of rows) {
      const found = byId.get(agenda.id) ?? {
        id: agenda.id as AgendaId,
        layout: agenda.layout as AgendaLayout,
        memberIds: [],
        horizonDays: agenda.horizonDays,
        createdAt: agenda.createdAt,
      };
      if (familyMemberId) found.memberIds.push(familyMemberId as FamilyMemberId);
      byId.set(agenda.id, found);
    }
    return [...byId.values()];
  }
}

async function insertMembers(tx: Pick<Database, "insert">, agenda: Agenda): Promise<void> {
  if (agenda.memberIds.length === 0) return;
  await tx
    .insert(agendaMembers)
    .values(agenda.memberIds.map((familyMemberId) => ({ agendaId: agenda.id, familyMemberId })));
}

export class PostgresSourceTypeRepository implements SourceTypeRepository {
  constructor(private readonly db: Database) {}

  async recordDiscovered(ids: SourceTypeId[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .insert(sourceTypes)
      .values(ids.map((id) => ({ id })))
      .onConflictDoNothing({ target: sourceTypes.id });
  }

  async list(): Promise<SourceTypeRecord[]> {
    const rows = await this.db.select().from(sourceTypes).orderBy(asc(sourceTypes.id));
    return rows.map((row) => ({ id: row.id as SourceTypeId, enabled: row.enabled }));
  }

  async enable(id: SourceTypeId): Promise<void> {
    await this.db.update(sourceTypes).set({ enabled: true }).where(eq(sourceTypes.id, id));
  }

  async disableIfUnused(id: SourceTypeId): Promise<boolean> {
    const unused = sql`NOT EXISTS (SELECT 1 FROM ${sources} WHERE ${sources.sourceTypeId} = ${id})`;
    const updated = await this.db
      .update(sourceTypes)
      .set({ enabled: false })
      .where(and(eq(sourceTypes.id, id), unused))
      .returning({ id: sourceTypes.id });
    return updated.length === 1;
  }
}

export class PostgresCatalogueRepository implements CatalogueRepository {
  constructor(private readonly db: Database) {}

  async recordDiscovered(sourceTypeId: SourceTypeId, entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) return;
    await this.db
      .insert(catalogueEntries)
      .values(entryIds.map((entryId) => ({ sourceTypeId, entryId })))
      .onConflictDoNothing({ target: [catalogueEntries.sourceTypeId, catalogueEntries.entryId] });
  }

  async list(sourceTypeId: SourceTypeId): Promise<CatalogueRecord[]> {
    const rows = await this.db
      .select()
      .from(catalogueEntries)
      .where(eq(catalogueEntries.sourceTypeId, sourceTypeId))
      .orderBy(asc(catalogueEntries.entryId));
    return rows.map(({ entryId, enabled, pollIntervalSeconds }) => ({ entryId, enabled, pollIntervalSeconds }));
  }

  async enable(sourceTypeId: SourceTypeId, entryId: string): Promise<void> {
    await this.db
      .update(catalogueEntries)
      .set({ enabled: true })
      .where(and(eq(catalogueEntries.sourceTypeId, sourceTypeId), eq(catalogueEntries.entryId, entryId)));
  }

  async setPollInterval(sourceTypeId: SourceTypeId, entryId: string, seconds: number | null): Promise<void> {
    await this.db
      .update(catalogueEntries)
      .set({ pollIntervalSeconds: seconds })
      .where(and(eq(catalogueEntries.sourceTypeId, sourceTypeId), eq(catalogueEntries.entryId, entryId)));
  }

  async disableIfUnused(sourceTypeId: SourceTypeId, entryId: string, configKey: string): Promise<boolean> {
    const unused = sql`NOT EXISTS (SELECT 1 FROM ${sources} WHERE ${sources.sourceTypeId} = ${sourceTypeId} AND ${sources.config} ->> ${configKey} = ${entryId})`;
    const updated = await this.db
      .update(catalogueEntries)
      .set({ enabled: false })
      .where(and(eq(catalogueEntries.sourceTypeId, sourceTypeId), eq(catalogueEntries.entryId, entryId), unused))
      .returning({ entryId: catalogueEntries.entryId });
    return updated.length === 1;
  }
}

export class PostgresSourceRepository implements SourceRepository {
  constructor(private readonly db: Database) {}

  async add(source: Source): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(sources).values({
        id: source.id,
        sourceTypeId: source.sourceTypeId,
        config: source.plain,
        configVersion: source.configVersion,
        secretRefs: source.secrets,
        pollIntervalSeconds: source.pollIntervalSeconds,
        shown: source.shown,
        name: source.name,
        createdAt: source.createdAt,
      });
      await tx.insert(sourceRuns).values({
        sourceId: source.id,
        syncCursor: cursorToJson(source.syncCursor),
        lastRunAt: source.lastRunAt,
        lastSuccessAt: source.lastSuccessAt,
        ...failureColumns(source.failure),
        lastNewRecordAt: source.lastNewRecordAt,
      });
    });
  }

  async list(): Promise<Source[]> {
    return this.select();
  }

  async listOfType(sourceTypeId: SourceTypeId): Promise<Source[]> {
    return this.select(eq(sources.sourceTypeId, sourceTypeId));
  }

  async findById(id: SourceId): Promise<Source | null> {
    if (!uuidPattern.test(id)) return null;
    const [source] = await this.select(eq(sources.id, id));
    return source ?? null;
  }

  async migrateConfig(id: SourceId, fromVersion: number, plain: PlainConfig, configVersion: number): Promise<void> {
    await this.db
      .update(sources)
      .set({ config: plain, configVersion })
      .where(and(eq(sources.id, id), eq(sources.configVersion, fromVersion)));
  }

  async update(source: Source): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(sources)
        .set({
          config: source.plain,
          configVersion: source.configVersion,
          secretRefs: source.secrets,
          pollIntervalSeconds: source.pollIntervalSeconds,
        })
        .where(eq(sources.id, source.id));
      await tx.update(sourceRuns).set({ lastRunAt: source.lastRunAt }).where(eq(sourceRuns.sourceId, source.id));
    });
  }

  async recordFailedRun(id: SourceId, at: Date, error: RunError): Promise<void> {
    await this.db
      .update(sourceRuns)
      .set({
        lastRunAt: at,
        failingSince: sql`coalesce(${sourceRuns.failingSince}, ${at})`,
        lastErrorKind: sql`CASE WHEN ${sourceRuns.lastErrorKind} = 'definite' THEN 'definite' ELSE ${error.kind} END`,
        lastError: error.message,
      })
      .where(eq(sourceRuns.sourceId, id));
  }

  async setShown(id: SourceId, shown: boolean): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db.update(sources).set({ shown }).where(eq(sources.id, id));
  }

  async rename(id: SourceId, name: string | null): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db.update(sources).set({ name }).where(eq(sources.id, id));
  }

  async declareAttributes(id: SourceId, attributes: DeclaredAttribute[]): Promise<void> {
    if (!uuidPattern.test(id) || attributes.length === 0) return;
    const ids = [...new Set(attributes.map((attribute) => attribute.externalId))];
    await this.db.transaction(async (tx) => {
      // A later declaration of the same id in one call wins.
      const named = new Map(attributes.map((attribute) => [attribute.externalId, attribute.name]));
      await tx
        .insert(sourceAttributes)
        .values([...named].map(([externalId, name]) => ({ sourceId: id, externalId, name })))
        .onConflictDoUpdate({
          target: [sourceAttributes.sourceId, sourceAttributes.externalId],
          set: { name: sql`excluded.name`, archivedAt: null },
        });
      // The ids that were refused as unknown no longer are.
      const declared = sql`ARRAY[${sql.join(ids.map((externalId) => sql`${externalId}`), sql`, `)}]::text[]`;
      const stillUnknown = sql`ARRAY(SELECT unnest(${sourceRuns.unknownAttributes}) EXCEPT SELECT unnest(${declared}))`;
      await tx
        .update(sourceRuns)
        .set({
          unknownAttributes: stillUnknown,
          unknownAttributesSince: sql`CASE WHEN cardinality(${stillUnknown}) = 0 THEN NULL ELSE ${sourceRuns.unknownAttributesSince} END`,
        })
        .where(eq(sourceRuns.sourceId, id));
    });
  }

  async archiveAttribute(id: SourceId, externalId: string): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db
      .update(sourceAttributes)
      .set({ archivedAt: sql`coalesce(${sourceAttributes.archivedAt}, now())` })
      .where(and(eq(sourceAttributes.sourceId, id), eq(sourceAttributes.externalId, externalId)));
  }

  async assignAttribute(id: SourceAttributeId, concerns: FamilyMemberId[]): Promise<boolean> {
    if (!uuidPattern.test(id)) return false;
    return this.db.transaction(async (tx) => {
      const [found] = await tx.select({ id: sourceAttributes.id }).from(sourceAttributes).where(eq(sourceAttributes.id, id));
      if (!found) return false;
      await tx.delete(sourceAttributeMembers).where(eq(sourceAttributeMembers.attributeId, id));
      if (concerns.length > 0) await tx.insert(sourceAttributeMembers).values(concerns.map((familyMemberId) => ({ attributeId: id, familyMemberId })));
      return true;
    });
  }

  async remove(id: SourceId): Promise<BlobRef[]> {
    if (!uuidPattern.test(id)) return [];
    return this.db.transaction(async (tx) => {
      const recordsOfSource = tx.select({ id: sourceRecords.id }).from(sourceRecords).where(eq(sourceRecords.sourceId, id));
      const attachments = await tx
        .select({ blob: sourceRecordAttachments.blob })
        .from(sourceRecordAttachments)
        .where(inArray(sourceRecordAttachments.recordId, recordsOfSource));
      // Removes its Source Records with their attachments and Items, by cascade.
      await tx.delete(sources).where(eq(sources.id, id));
      return attachments.map((row) => row.blob as BlobRef);
    });
  }

  private async select(where?: SQL): Promise<Source[]> {
    const rows = await this.db
      .select({ source: sources, run: sourceRuns, syncCursor: syncCursorAsText })
      .from(sources)
      .innerJoin(sourceRuns, eq(sourceRuns.sourceId, sources.id))
      .where(where)
      .orderBy(asc(sources.position));
    const attributes = await this.attributesOf(rows.map((row) => row.source.id));
    return rows.map(({ source, run, syncCursor }) => ({
      id: source.id as SourceId,
      sourceTypeId: source.sourceTypeId as SourceTypeId,
      plain: source.config,
      configVersion: source.configVersion,
      secrets: source.secretRefs as Record<string, SecretRef>,
      syncCursor,
      pollIntervalSeconds: source.pollIntervalSeconds,
      shown: source.shown,
      name: source.name,
      attributes: attributes.get(source.id) ?? [],
      lastRunAt: run.lastRunAt,
      lastSuccessAt: run.lastSuccessAt,
      failure:
        run.failingSince && run.lastError !== null
          ? { kind: run.lastErrorKind === "definite" ? "definite" : "temporary", message: run.lastError, since: run.failingSince }
          : null,
      lastNewRecordAt: run.lastNewRecordAt,
      invalidRecords: run.invalidRecords,
      unknownAttributes: run.unknownAttributes,
      createdAt: source.createdAt,
    }));
  }

  /** The Source Attributes of the Sources, by name, each with the Family Members assigned to it in the Family's order. */
  private async attributesOf(sourceIds: string[]): Promise<Map<string, SourceAttribute[]>> {
    const found = new Map<string, SourceAttribute[]>();
    if (sourceIds.length === 0) return found;
    const rows = await this.db
      .select({ attribute: sourceAttributes, familyMemberId: sourceAttributeMembers.familyMemberId })
      .from(sourceAttributes)
      .leftJoin(sourceAttributeMembers, eq(sourceAttributeMembers.attributeId, sourceAttributes.id))
      .leftJoin(familyMembers, eq(familyMembers.id, sourceAttributeMembers.familyMemberId))
      .where(inArray(sourceAttributes.sourceId, sourceIds))
      .orderBy(asc(sourceAttributes.name), asc(sourceAttributes.id), asc(familyMembers.position));
    const byId = new Map<string, SourceAttribute>();
    for (const { attribute, familyMemberId } of rows) {
      let entry = byId.get(attribute.id);
      if (!entry) {
        entry = { id: attribute.id as SourceAttributeId, externalId: attribute.externalId, name: attribute.name, archived: attribute.archivedAt !== null, concerns: [] };
        byId.set(attribute.id, entry);
        found.set(attribute.sourceId, [...(found.get(attribute.sourceId) ?? []), entry]);
      }
      if (familyMemberId) entry.concerns.push(familyMemberId as FamilyMemberId);
    }
    return found;
  }
}

/**
 * A plugin's sync cursor as the JSON string `sync_cursor` holds. It is converted in SQL, as drizzle
 * would parse again a `jsonb` value the driver has already parsed, turning the cursor `"1"` into 1.
 */
export const cursorToJson = (syncCursor: string | null): SQL => sql`to_jsonb(${syncCursor}::text)`;

/** The plugin's sync cursor read back from `sync_cursor`, as text for the reason above. */
const syncCursorAsText = sql<string | null>`${sourceRuns.syncCursor} #>> '{}'`;

export function failureColumns(failure: SourceFailure | null) {
  return {
    failingSince: failure?.since ?? null,
    lastErrorKind: failure?.kind ?? null,
    lastError: failure?.message ?? null,
  };
}

export class PostgresLlmEndpointRepository implements LlmEndpointRepository {
  constructor(private readonly db: Database) {}

  async find(): Promise<StoredLlmEndpoint | null> {
    const [row] = await this.db.select().from(llmEndpoints);
    if (!row) return null;
    return {
      baseUrl: row.baseUrl,
      model: row.model,
      apiKey: row.apiKeyRef as SecretRef | null,
      acknowledgedAt: row.acknowledgedAt,
      savedAt: row.savedAt,
    };
  }

  async save(endpoint: StoredLlmEndpoint): Promise<void> {
    const values = {
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      apiKeyRef: endpoint.apiKey,
      acknowledgedAt: endpoint.acknowledgedAt,
      savedAt: endpoint.savedAt,
    };
    await this.db
      .insert(llmEndpoints)
      .values(values)
      .onConflictDoUpdate({ target: llmEndpoints.id, set: values });
  }
}

export class PostgresIdentityProviderRepository implements IdentityProviderRepository {
  constructor(private readonly db: Database) {}

  async find(): Promise<StoredIdentityProvider | null> {
    const [row] = await this.db.select().from(identityProviders);
    if (!row) return null;
    return {
      enabled: row.enabled,
      issuerUrl: row.issuerUrl,
      clientId: row.clientId,
      clientSecret: row.clientSecretRef as SecretRef | null,
      requiredGroup: row.requiredGroup,
      publicBaseUrl: row.publicBaseUrl,
      savedAt: row.savedAt,
    };
  }

  async save(provider: StoredIdentityProvider): Promise<void> {
    const values = {
      enabled: provider.enabled,
      issuerUrl: provider.issuerUrl,
      clientId: provider.clientId,
      clientSecretRef: provider.clientSecret,
      requiredGroup: provider.requiredGroup,
      publicBaseUrl: provider.publicBaseUrl,
      savedAt: provider.savedAt,
    };
    await this.db
      .insert(identityProviders)
      .values(values)
      .onConflictDoUpdate({ target: identityProviders.id, set: values });
  }
}

export class PostgresActivityRepository implements ActivityRepository {
  constructor(private readonly db: Database) {}

  async find(): Promise<BackgroundActivity | null> {
    const [row] = await this.db.select().from(backgroundActivities);
    if (!row) return null;
    return { kind: row.kind as ActivityKind, done: row.done, total: row.total, updatedAt: row.updatedAt };
  }

  async save(activity: BackgroundActivity): Promise<void> {
    await this.db
      .insert(backgroundActivities)
      .values(activity)
      .onConflictDoUpdate({ target: backgroundActivities.id, set: activity });
  }

  async clear(): Promise<void> {
    await this.db.delete(backgroundActivities);
  }
}
