import { parseFamilyId, type FamilyId } from "./family-id";
import type {
  ActivityKind,
  ActivityRepository,
  AddingId,
  AddingProgress,
  SourceAdding,
  SourceAddingRepository,
  AdminSession,
  AdminSessionRepository,
  BackgroundActivity,
  CatalogueRecord,
  CatalogueRepository,
  DeclaredAttribute,
  FamilyMemberRepository,
  FamilyRepository,
  SoleAssignment,
  LlmEndpointRepository,
  PlainConfig,
  RegistrationInboxRepository,
  RegistrationTaken,
  StoredRegistration,
  FamilyCreated,
  FamilyCreatedDeliveryRepository,
  PendingDelivery,
  SecretRef,
  Source,
  SourceAttribute,
  SourceRepository,
  SourceRunTurns,
  SourceTypeRecord,
  SourceTypeRepository,
  StoredLlmEndpoint,
  AgendaRepository,
} from "@family-agenda/application";
import type {
  BlobRef,
  FamilyLanguages,
  FamilyMember,
  FamilyMemberId,
  MemberAvatar,
  MemberColour,
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
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { uuidPattern } from "../uuid";
import type { Database } from "./database";
import {
  adminSessions,
  backgroundActivities,
  sourceAddings,
  catalogueEntries,
  family,
  familyMembers,
  llmEndpoints,
  registrations,
  familyCreatedDeliveries,
  sourceAttributeMembers,
  sourceAttributes,
  sourceRecordAttributes,
  sourceRecordAttachments,
  sourceRecords,
  sourceRuns,
  sourceRunTurns,
  sources,
  sourceTypes,
  agendaMembers,
  agendas,
} from "./schema";

/** Reads and writes the one row of `family`, which the schema creates (ADR-0003). */
export class PostgresFamilyRepository implements FamilyRepository {
  constructor(private readonly db: Database) {}

  async familyId(): Promise<FamilyId> {
    const [row] = await this.db.select({ familyId: family.familyId }).from(family);
    const familyId = parseFamilyId(row?.familyId);
    if (!familyId) throw new Error("the family row is missing");
    return familyId;
  }

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

  async organizationId(): Promise<string | null> {
    const [row] = await this.db.select({ organizationId: family.organizationId }).from(family);
    return row?.organizationId ?? null;
  }

  async recordOrganizationId(organizationId: string): Promise<boolean> {
    const recorded = await this.db
      .update(family)
      .set({ organizationId })
      .where(isNull(family.organizationId))
      .returning({ organizationId: family.organizationId });
    return recorded.length > 0;
  }
}

export class PostgresAdminSessionRepository implements AdminSessionRepository {
  constructor(private readonly db: Database) {}

  async add(session: AdminSession): Promise<void> {
    await this.db.insert(adminSessions).values(session);
  }

  async find(id: string): Promise<AdminSession | null> {
    const [row] = await this.db.select().from(adminSessions).where(eq(adminSessions.id, id));
    return row ? { id: row.id, subject: row.subject, email: row.email, idToken: row.idToken, expiresAt: row.expiresAt } : null;
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(adminSessions).where(eq(adminSessions.id, id));
  }

  async removeExpired(now: Date): Promise<void> {
    await this.db.delete(adminSessions).where(lte(adminSessions.expiresAt, now));
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
      .set({ name: member.name, colour: member.colour, avatar: member.avatar, ...photoColumns(member) })
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
    colour: row.colour as MemberColour,
    avatar: row.avatar as MemberAvatar | null,
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
        secretHosts: source.secretHosts,
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
          secretHosts: source.secretHosts,
          pollIntervalSeconds: source.pollIntervalSeconds,
        })
        .where(eq(sources.id, source.id));
      await tx.update(sourceRuns).set({ lastRunAt: source.lastRunAt }).where(eq(sourceRuns.sourceId, source.id));
    });
  }

  async replaceSecretsInTurn(id: SourceId, holder: string, secrets: Record<string, SecretRef>): Promise<boolean> {
    return inHeldTurn(this.db, id, holder, async (tx) => {
      await tx.update(sources).set({ secretRefs: secrets }).where(eq(sources.id, id));
    });
  }

  async recordFailedRun(id: SourceId, at: Date, error: RunError): Promise<void> {
    await failedRunRecorded(this.db, id, at, error);
  }

  async recordFailedRunInTurn(id: SourceId, holder: string, at: Date, error: RunError): Promise<boolean> {
    return inHeldTurn(this.db, id, holder, (tx) => failedRunRecorded(tx, id, at, error));
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
    await this.db.transaction((tx) => attributesDeclared(tx, id, attributes));
  }

  async declareAttributesInTurn(id: SourceId, holder: string, attributes: DeclaredAttribute[]): Promise<boolean> {
    if (!uuidPattern.test(id)) return false;
    return inHeldTurn(this.db, id, holder, async (tx) => {
      if (attributes.length > 0) await attributesDeclared(tx, id, attributes);
    });
  }

  async archiveAttribute(id: SourceId, externalId: string): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await attributeArchived(this.db, id, externalId);
  }

  async archiveAttributeInTurn(id: SourceId, holder: string, externalId: string): Promise<boolean> {
    if (!uuidPattern.test(id)) return false;
    return inHeldTurn(this.db, id, holder, (tx) => attributeArchived(tx, id, externalId));
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
      // The Copies in other Sources of its messages lose the Source Attributes it gave them (ADR-0005).
      await tx
        .delete(sourceRecordAttributes)
        .where(inArray(sourceRecordAttributes.attributeId, tx.select({ id: sourceAttributes.id }).from(sourceAttributes).where(eq(sourceAttributes.sourceId, id))));
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
      secretHosts: source.secretHosts,
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

  async remove(): Promise<void> {
    await this.db.delete(llmEndpoints);
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

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Locks the row of the Source's turn while `holder` holds it unexpired, so that no other process
 * takes it until the transaction ends (ADR-0008); whether it holds it.
 */
export async function lockHeldTurn(tx: Transaction, sourceId: SourceId, holder: string): Promise<boolean> {
  const [held] = await tx
    .select({ holder: sourceRunTurns.holder })
    .from(sourceRunTurns)
    .where(and(eq(sourceRunTurns.sourceId, sourceId), eq(sourceRunTurns.holder, holder), gt(sourceRunTurns.expiresAt, sql`now()`)))
    .for("update");
  return held !== undefined;
}

/** Does `work` in a transaction only while `holder` holds the Source's turn; whether it did. */
function inHeldTurn(db: Database, sourceId: SourceId, holder: string, work: (tx: Transaction) => Promise<void>): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockHeldTurn(tx, sourceId, holder))) return false;
    await work(tx);
    return true;
  });
}

/**
 * Makes the Source Attributes known: an unknown id is inserted, a known one gets its name and is
 * revived; the ids no longer count as unknown on the Source's run state.
 */
async function attributesDeclared(tx: Transaction, id: SourceId, attributes: DeclaredAttribute[]): Promise<void> {
  const ids = [...new Set(attributes.map((attribute) => attribute.externalId))];
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
}

/** Archives a Source Attribute by its external id; an unknown one is ignored. */
async function attributeArchived(db: Database | Transaction, id: SourceId, externalId: string): Promise<void> {
  await db
    .update(sourceAttributes)
    .set({ archivedAt: sql`coalesce(${sourceAttributes.archivedAt}, now())` })
    .where(and(eq(sourceAttributes.sourceId, id), eq(sourceAttributes.externalId, externalId)));
}

/** Records a failed run, which keeps the sync cursor for the next one. */
async function failedRunRecorded(db: Database | Transaction, id: SourceId, at: Date, error: RunError): Promise<void> {
  await db
    .update(sourceRuns)
    .set({
      lastRunAt: at,
      failingSince: sql`coalesce(${sourceRuns.failingSince}, ${at})`,
      lastErrorKind: sql`CASE WHEN ${sourceRuns.lastErrorKind} = 'definite' THEN 'definite' ELSE ${error.kind} END`,
      lastError: error.message,
    })
    .where(eq(sourceRuns.sourceId, id));
}

/** When a turn lasting so long from the database's now expires. */
const expiryAfter = (lastsMs: number) => sql`now() + ${lastsMs} * interval '1 millisecond'`;

/** The turns of the Sources' runs, each taken and renewed in one statement, by the database's clock. */
export class PostgresSourceRunTurns implements SourceRunTurns {
  constructor(private readonly db: Database) {}

  async take(sourceId: SourceId, holder: string, lastsMs: number): Promise<boolean> {
    const taken = await this.db
      .insert(sourceRunTurns)
      .values({ sourceId, holder, expiresAt: expiryAfter(lastsMs) })
      .onConflictDoUpdate({ target: sourceRunTurns.sourceId, set: { holder, expiresAt: expiryAfter(lastsMs) }, setWhere: lt(sourceRunTurns.expiresAt, sql`now()`) })
      .returning({ holder: sourceRunTurns.holder });
    return taken.length > 0;
  }

  async renew(sourceId: SourceId, holder: string, lastsMs: number): Promise<boolean> {
    const renewed = await this.db
      .update(sourceRunTurns)
      .set({ expiresAt: expiryAfter(lastsMs) })
      .where(and(eq(sourceRunTurns.sourceId, sourceId), eq(sourceRunTurns.holder, holder), gt(sourceRunTurns.expiresAt, sql`now()`)))
      .returning({ holder: sourceRunTurns.holder });
    return renewed.length > 0;
  }

  async end(sourceId: SourceId, holder: string): Promise<void> {
    await this.db.delete(sourceRunTurns).where(and(eq(sourceRunTurns.sourceId, sourceId), eq(sourceRunTurns.holder, holder)));
  }
}

export class PostgresSourceAddingRepository implements SourceAddingRepository {
  constructor(private readonly db: Database) {}

  async start(adding: SourceAdding): Promise<void> {
    await this.db.insert(sourceAddings).values(adding);
  }

  async end(id: AddingId, progress: AddingProgress): Promise<void> {
    await this.db
      .update(sourceAddings)
      .set({ progress })
      .where(and(eq(sourceAddings.id, id), sql`${sourceAddings.progress}->>'status' = 'running'`));
  }

  async find(id: AddingId): Promise<SourceAdding | null> {
    const [row] = await this.db.select().from(sourceAddings).where(eq(sourceAddings.id, id));
    return row ? addingOf(row) : null;
  }

  async listOfType(sourceTypeId: string): Promise<SourceAdding[]> {
    const rows = await this.db.select().from(sourceAddings).where(sql`${sourceAddings.progress}->>'sourceTypeId' = ${sourceTypeId}`).orderBy(asc(sourceAddings.position));
    return rows.map(addingOf);
  }

  async remove(id: AddingId): Promise<void> {
    await this.db.delete(sourceAddings).where(eq(sourceAddings.id, id));
  }

  async removeStartedBefore(startedBefore: Date): Promise<void> {
    await this.db.delete(sourceAddings).where(lt(sourceAddings.startedAt, startedBefore));
  }
}

function addingOf(row: typeof sourceAddings.$inferSelect): SourceAdding {
  return { id: row.id as AddingId, startedAt: row.startedAt, progress: row.progress };
}

/** A lock no other statement takes, held while a fixed Family's registration is taken: one at a time. */
const registrationLockKey = 0x7265_6731;

/** The registrations received (ADR-0010): each statement takes or changes one so that concurrent cores take each once. */
export class PostgresRegistrationInboxRepository implements RegistrationInboxRepository {
  constructor(private readonly db: Database) {}

  async add(registration: { userId: string; email: string; familyId: string | null }, at: Date): Promise<boolean> {
    const added = await this.db
      .insert(registrations)
      .values({ ...registration, nextAttemptAt: at })
      .onConflictDoNothing()
      .returning({ userId: registrations.userId });
    return added.length > 0;
  }

  takeDue(now: Date, leaseUntil: Date, limit: number, alone: boolean): Promise<StoredRegistration[]> {
    return this.db.transaction(async (tx) => {
      if (alone && (await heldElsewhere(tx, now))) return [];
      // Skips registrations another core is taking at the same moment; each is held as it is taken.
      const due = tx
        .select({ userId: registrations.userId })
        .from(registrations)
        .where(and(isNull(registrations.doneAt), lte(registrations.nextAttemptAt, now), free(now)))
        .orderBy(asc(registrations.nextAttemptAt))
        .limit(alone ? 1 : limit)
        .for("update", { skipLocked: true });
      return tx.update(registrations).set({ leasedUntil: leaseUntil }).where(inArray(registrations.userId, due)).returning(storedColumns);
    });
  }

  takeOf(userId: string, now: Date, leaseUntil: Date, alone: boolean): Promise<RegistrationTaken> {
    return this.db.transaction(async (tx) => {
      if (alone && (await heldElsewhere(tx, now, userId))) return "busy";
      const [row] = await tx.select().from(registrations).where(eq(registrations.userId, userId)).for("update");
      if (row === undefined || row.doneAt !== null) return "settled";
      if (row.leasedUntil !== null && row.leasedUntil > now) return "busy";
      const [taken] = await tx.update(registrations).set({ leasedUntil: leaseUntil }).where(eq(registrations.userId, userId)).returning(storedColumns);
      return taken ? { taken } : "settled";
    });
  }

  async noteOrganization(userId: string, organizationId: string): Promise<void> {
    await this.db.update(registrations).set({ organizationId }).where(eq(registrations.userId, userId));
  }

  async done(userId: string, at: Date): Promise<void> {
    await this.db.update(registrations).set({ doneAt: at, leasedUntil: null }).where(eq(registrations.userId, userId));
  }

  async retryAt(userId: string, attempts: number, at: Date): Promise<void> {
    await this.db.update(registrations).set({ attempts, nextAttemptAt: at, leasedUntil: null }).where(eq(registrations.userId, userId));
  }
}

const storedColumns = {
  userId: registrations.userId,
  email: registrations.email,
  familyId: registrations.familyId,
  organizationId: registrations.organizationId,
  attempts: registrations.attempts,
};

/** A registration no core holds at `now`. */
const free = (now: Date): SQL | undefined => or(isNull(registrations.leasedUntil), lte(registrations.leasedUntil, now));

/** Takes the lock of a fixed Family's registration for the transaction; whether another than `userId`'s is held now. */
async function heldElsewhere(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], now: Date, userId = ""): Promise<boolean> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${registrationLockKey})`);
  const held = await tx
    .select({ userId: registrations.userId })
    .from(registrations)
    .where(and(isNull(registrations.doneAt), isNotNull(registrations.leasedUntil), gt(registrations.leasedUntil, now), sql`${registrations.userId} <> ${userId}`))
    .limit(1);
  return held.length > 0;
}

/** The pending `family.created` deliveries, in the registration database of a core in supplied mode (ADR-0010). */
export class PostgresFamilyCreatedDeliveryRepository implements FamilyCreatedDeliveryRepository {
  constructor(private readonly db: Database) {}

  async add(created: FamilyCreated, dueAt: Date): Promise<void> {
    await this.db.insert(familyCreatedDeliveries).values({ ...created, nextAttemptAt: dueAt }).onConflictDoNothing();
  }

  async takeDue(now: Date, leaseUntil: Date, limit: number): Promise<PendingDelivery[]> {
    // Skips rows another core is taking at the same moment; each is pushed ahead as it is taken.
    const due = this.db
      .select({ familyId: familyCreatedDeliveries.familyId })
      .from(familyCreatedDeliveries)
      .where(lte(familyCreatedDeliveries.nextAttemptAt, now))
      .orderBy(asc(familyCreatedDeliveries.nextAttemptAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    return this.db
      .update(familyCreatedDeliveries)
      .set({ nextAttemptAt: leaseUntil })
      .where(inArray(familyCreatedDeliveries.familyId, due))
      .returning({
        familyId: familyCreatedDeliveries.familyId,
        organizationId: familyCreatedDeliveries.organizationId,
        email: familyCreatedDeliveries.email,
        attempts: familyCreatedDeliveries.attempts,
      });
  }

  async delivered(familyId: string): Promise<void> {
    await this.db.delete(familyCreatedDeliveries).where(eq(familyCreatedDeliveries.familyId, familyId));
  }

  async retryAt(familyId: string, attempts: number, at: Date): Promise<void> {
    await this.db.update(familyCreatedDeliveries).set({ attempts, nextAttemptAt: at }).where(eq(familyCreatedDeliveries.familyId, familyId));
  }
}
