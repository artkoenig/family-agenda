import { createHash, randomUUID } from "node:crypto";
import type {
  ActivityKind,
  ActivityRepository,
  AdminRepository,
  AuthoredRevision,
  AdminSession,
  AdminSessionRepository,
  BackgroundActivity,
  CatalogueRecord,
  CatalogueRepository,
  Extraction,
  FamilyMemberRepository,
  FamilyRepository,
  ItemProjection,
  ItemRepository,
  LlmEndpointRepository,
  NewRevision,
  PendingMessage,
  PlainConfig,
  ProjectedItem,
  RawMessage,
  SecretRef,
  SignInFailureLog,
  Source,
  SourceRepository,
  SourceRun,
  SourceTypeRecord,
  SourceTypeRepository,
  StoredLlmEndpoint,
  ThreadItem,
  AgendaRepository,
} from "@family-agenda/application";
import type {
  Act,
  Admin,
  AdminId,
  BlobRef,
  Email,
  FamilyLanguages,
  FamilyMember,
  FamilyMemberId,
  FoldableRevision,
  ItemId,
  ItemKind,
  OcrLanguage,
  PhotoType,
  RawMessageId,
  RunError,
  SourceFailure,
  SourceId,
  SourceTypeId,
  Agenda,
  AgendaId,
  AgendaKind,
} from "@family-agenda/domain";
import { defaultFamilyLanguage, isFamilyLanguage } from "@family-agenda/domain";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { uuidPattern } from "../uuid";
import type { Database } from "./database";
import {
  admins,
  adminSessions,
  backgroundActivities,
  catalogueEntries,
  family,
  familyMembers,
  itemKeys,
  items,
  llmEndpoints,
  revisions,
  signInFailures,
  sourceRecordAttachments,
  sourceRecords,
  sourceRuns,
  sourceMembers,
  sources,
  sourceTypes,
  agendaPreselections,
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

  async remove(id: FamilyMemberId): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db.delete(familyMembers).where(eq(familyMembers.id, id));
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
      await insertPreselections(tx, agenda);
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
      await tx.update(agendas).set({ kind: agenda.kind, horizonDays: agenda.horizonDays }).where(eq(agendas.id, agenda.id));
      await tx.delete(agendaPreselections).where(eq(agendaPreselections.agendaId, agenda.id));
      await insertPreselections(tx, agenda);
    });
  }

  async remove(id: AgendaId): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db.delete(agendas).where(eq(agendas.id, id));
  }

  private async select(where?: SQL): Promise<Agenda[]> {
    const rows = await this.db
      .select({ agenda: agendas, familyMemberId: agendaPreselections.familyMemberId })
      .from(agendas)
      .leftJoin(agendaPreselections, eq(agendaPreselections.agendaId, agendas.id))
      .leftJoin(familyMembers, eq(familyMembers.id, agendaPreselections.familyMemberId))
      .where(where)
      .orderBy(asc(agendas.position), asc(familyMembers.position));
    const byId = new Map<string, Agenda>();
    for (const { agenda, familyMemberId } of rows) {
      const found = byId.get(agenda.id) ?? {
        id: agenda.id as AgendaId,
        kind: agenda.kind as AgendaKind,
        preselected: [],
        horizonDays: agenda.horizonDays,
        createdAt: agenda.createdAt,
      };
      if (familyMemberId) found.preselected.push(familyMemberId as FamilyMemberId);
      byId.set(agenda.id, found);
    }
    return [...byId.values()];
  }
}

async function insertPreselections(tx: Pick<Database, "insert">, agenda: Agenda): Promise<void> {
  if (agenda.preselected.length === 0) return;
  await tx
    .insert(agendaPreselections)
    .values(agenda.preselected.map((familyMemberId) => ({ agendaId: agenda.id, familyMemberId })));
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
        lastNewOriginAt: source.lastNewOriginAt,
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

  async assign(id: SourceId, concerns: FamilyMemberId[]): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db.transaction(async (tx) => {
      await tx.delete(sourceMembers).where(and(eq(sourceMembers.sourceId, id), eq(sourceMembers.part, "")));
      if (concerns.length > 0) await tx.insert(sourceMembers).values(concerns.map((familyMemberId) => ({ sourceId: id, familyMemberId })));
    });
  }

  async assignParts(id: SourceId, parts: Record<string, FamilyMemberId[]>): Promise<void> {
    if (!uuidPattern.test(id)) return;
    const rows = Object.entries(parts).flatMap(([part, assigned]) => assigned.map((familyMemberId) => ({ sourceId: id, part, familyMemberId })));
    await this.db.transaction(async (tx) => {
      await tx.delete(sourceMembers).where(and(eq(sourceMembers.sourceId, id), ne(sourceMembers.part, "")));
      if (rows.length > 0) await tx.insert(sourceMembers).values(rows);
    });
  }

  async remove(id: SourceId, recompute: Recompute): Promise<BlobRef[]> {
    if (!uuidPattern.test(id)) return [];
    return this.db.transaction(async (tx) => {
      const recordsOfSource = tx.select({ id: sourceRecords.id }).from(sourceRecords).where(eq(sourceRecords.sourceId, id));
      const attachments = await tx
        .select({ blob: sourceRecordAttachments.blob })
        .from(sourceRecordAttachments)
        .where(inArray(sourceRecordAttachments.recordId, recordsOfSource));
      // The Items the Source names or stated something about; other Sources may name them too.
      const named = tx.select({ id: itemKeys.itemId }).from(itemKeys).where(eq(itemKeys.sourceId, id));
      const stated = tx.select({ id: revisions.itemId }).from(revisions).where(inArray(revisions.originId, recordsOfSource));
      const reached = await tx
        .select({ id: items.id, kind: items.kind })
        .from(items)
        .where(or(inArray(items.id, named), inArray(items.id, stated)));
      // Removes its Source Records with their attachments and Revisions, and its Item keys, by cascade.
      await tx.delete(sources).where(eq(sources.id, id));
      if (reached.length > 0) {
        const unnamed = await tx
          .delete(items)
          .where(
            and(
              inArray(
                items.id,
                reached.map((item) => item.id),
              ),
              sql`NOT EXISTS (SELECT 1 FROM ${itemKeys} WHERE ${itemKeys.itemId} = ${items.id})`,
            ),
          )
          .returning({ id: items.id });
        const gone = new Set(unnamed.map((item) => item.id));
        const kept = reached.filter((item) => !gone.has(item.id));
        await recomputeAll(tx, new Map(kept.map((item) => [item.id as ItemId, item.kind as ItemKind])), recompute);
      }
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
    const assigned = await this.db
      .select({ sourceId: sourceMembers.sourceId, part: sourceMembers.part, familyMemberId: sourceMembers.familyMemberId })
      .from(sourceMembers)
      .innerJoin(familyMembers, eq(familyMembers.id, sourceMembers.familyMemberId))
      .where(
        rows.length > 0
          ? inArray(
              sourceMembers.sourceId,
              rows.map((row) => row.source.id),
            )
          : sql`false`,
      )
      .orderBy(asc(familyMembers.position));
    const concernsOf = (id: string) =>
      assigned.filter((row) => row.sourceId === id && row.part === "").map((row) => row.familyMemberId as FamilyMemberId);
    const partConcernsOf = (id: string) => {
      const parts: Record<string, FamilyMemberId[]> = {};
      for (const row of assigned) if (row.sourceId === id && row.part !== "") (parts[row.part] ??= []).push(row.familyMemberId as FamilyMemberId);
      return parts;
    };
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
      concerns: concernsOf(source.id),
      partConcerns: partConcernsOf(source.id),
      lastRunAt: run.lastRunAt,
      lastSuccessAt: run.lastSuccessAt,
      failure:
        run.failingSince && run.lastError !== null
          ? { kind: run.lastErrorKind === "definite" ? "definite" : "temporary", message: run.lastError, since: run.failingSince }
          : null,
      lastNewOriginAt: run.lastNewOriginAt,
      createdAt: source.createdAt,
    }));
  }
}

/**
 * A plugin's sync cursor as the JSON string `sync_cursor` holds. It is converted in SQL, as drizzle
 * would parse again a `jsonb` value the driver has already parsed, turning the cursor `"1"` into 1.
 */
const cursorToJson = (syncCursor: string | null): SQL => sql`to_jsonb(${syncCursor}::text)`;

/** The plugin's sync cursor read back from `sync_cursor`, as text for the reason above. */
const syncCursorAsText = sql<string | null>`${sourceRuns.syncCursor} #>> '{}'`;

function failureColumns(failure: SourceFailure | null) {
  return {
    failingSince: failure?.since ?? null,
    lastErrorKind: failure?.kind ?? null,
    lastError: failure?.message ?? null,
  };
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type Recompute = (kind: ItemKind, revisions: FoldableRevision[]) => ItemProjection;

export class PostgresItemRepository implements ItemRepository {
  constructor(private readonly db: Database) {}

  async recordRun(run: SourceRun, recompute: Recompute): Promise<{ knownMessages: string[]; withdrawnFiles: BlobRef[] }> {
    return this.db.transaction(async (tx) => {
      const reached = new Map<ItemId, ItemKind>();
      const knownMessages: string[] = [];
      for (const origin of run.origins) {
        const { message } = origin;
        const [row] = await tx
          .insert(sourceRecords)
          .values({
            sourceId: run.sourceId,
            externalId: origin.externalId,
            occurredAt: origin.occurredAt,
            sender: message?.sender ?? null,
            subject: message?.subject ?? null,
            body: message?.body ?? null,
            createdAt: run.at,
            attributes: origin.attributes,
            link: origin.link,
            part: origin.part,
            thread: message?.thread ?? null,
          })
          .onConflictDoUpdate({
            target: [sourceRecords.sourceId, sourceRecords.externalId],
            // A later appearance without a link, such as a cancellation, keeps the link. A message
            // keeps what it was first recorded with; a withdrawn one arriving again stays without it.
            set: {
              attributes: origin.attributes,
              link: sql`coalesce(excluded.link, ${sourceRecords.link})`,
              withdrawnAt: null,
            },
          })
          // A row the insert wrote has no previous version, so its xmax is 0.
          .returning({ id: sourceRecords.id, inserted: sql<boolean>`(xmax = 0)` });
        if (!row) throw new Error("recording a Source Record returned no row");
        if (message && !row.inserted) knownMessages.push(origin.externalId);
        else if (message && message.attachments.length > 0) {
          await tx.insert(sourceRecordAttachments).values(
            message.attachments.map((attachment, position) => ({
              recordId: row.id,
              position,
              filename: attachment.filename,
              mediaType: attachment.contentType,
              blob: attachment.blob,
              sha256: attachment.sha256,
              size: attachment.size,
            })),
          );
        }
        await this.append(tx, { sourceId: run.sourceId, originId: row.id, at: run.at }, origin.revisions, reached);
      }
      const withdrawnFiles = await this.withdraw(tx, run, reached);
      await recomputeAll(tx, reached, recompute);
      const lastNewOrigin = tx
        .select({ at: sql`max(${sourceRecords.createdAt})` })
        .from(sourceRecords)
        .where(eq(sourceRecords.sourceId, run.sourceId));
      await tx
        .update(sourceRuns)
        .set({
          syncCursor: cursorToJson(run.syncCursor),
          lastRunAt: run.at,
          lastSuccessAt: run.at,
          ...failureColumns(null),
          lastNewOriginAt: sql`(${lastNewOrigin})`,
        })
        .where(eq(sourceRuns.sourceId, run.sourceId));
      return { knownMessages, withdrawnFiles };
    });
  }

  /**
   * Marks the Source Records the Source deleted as withdrawn, rejects their Revisions and removes
   * their messages' text and attachments; notes the Items they reach. Returns the files of the
   * removed attachments.
   */
  private async withdraw(tx: Transaction, run: SourceRun, reached: Map<ItemId, ItemKind>): Promise<BlobRef[]> {
    if (run.withdrawn.length === 0) return [];
    const withdrawing = and(
      eq(sourceRecords.sourceId, run.sourceId),
      inArray(sourceRecords.externalId, run.withdrawn),
      isNull(sourceRecords.withdrawnAt),
    );
    const withdrawn = await tx
      .update(sourceRecords)
      .set({ withdrawnAt: run.at, sender: null, subject: null, body: null })
      .where(withdrawing)
      .returning({ id: sourceRecords.id });
    if (withdrawn.length === 0) return [];
    const ids = withdrawn.map((row) => row.id);
    const attachments = await tx
      .delete(sourceRecordAttachments)
      .where(inArray(sourceRecordAttachments.recordId, ids))
      .returning({ blob: sourceRecordAttachments.blob });
    const rejected = await tx
      .update(revisions)
      .set({ accepted: false, rejection: "origin-withdrawn" })
      .where(and(inArray(revisions.originId, ids), eq(revisions.accepted, true)))
      .returning({ itemId: revisions.itemId });
    await noteReached(tx, rejected.map((row) => row.itemId as ItemId), reached);
    return attachments.map((row) => row.blob as BlobRef);
  }

  async pendingMessages(limit: number): Promise<PendingMessage[]> {
    const rows = await this.db
      .select({
        id: sourceRecords.id,
        sourceId: sourceRecords.sourceId,
        externalId: sourceRecords.externalId,
        sentAt: sourceRecords.occurredAt,
        thread: sourceRecords.thread,
        body: sourceRecords.body,
      })
      .from(sourceRecords)
      .where(pendingMessage)
      .orderBy(asc(sourceRecords.createdAt), asc(sourceRecords.occurredAt))
      .limit(limit);
    const attachments =
      rows.length === 0
        ? []
        : await this.db
            .select()
            .from(sourceRecordAttachments)
            .where(inArray(sourceRecordAttachments.recordId, rows.map((row) => row.id)))
            .orderBy(asc(sourceRecordAttachments.position));
    return rows.map((row) => ({
      ...row,
      id: row.id as RawMessageId,
      sourceId: row.sourceId as SourceId,
      // The query takes only records with a body.
      body: row.body ?? "",
      attachments: attachments.flatMap((attachment) =>
        attachment.recordId === row.id
          ? [{ position: attachment.position, filename: attachment.filename, contentType: attachment.mediaType, blob: attachment.blob as BlobRef }]
          : [],
      ),
    }));
  }

  async itemsOfThread(
    sourceId: SourceId,
    thread: string,
    before: { messageId: RawMessageId; sentAt: Date },
    recompute: Recompute,
  ): Promise<ThreadItem[]> {
    const rows = await this.db
      .selectDistinct({ id: items.id, itemKey: itemKeys.itemKey, kind: items.kind, createdAt: items.createdAt })
      .from(sourceRecords)
      .innerJoin(revisions, eq(revisions.originId, sourceRecords.id))
      .innerJoin(items, eq(items.id, revisions.itemId))
      .innerJoin(itemKeys, and(eq(itemKeys.itemId, items.id), eq(itemKeys.sourceId, sourceRecords.sourceId)))
      .where(
        and(
          eq(sourceRecords.sourceId, sourceId),
          eq(sourceRecords.thread, thread),
          // A withdrawn message no longer says anything to the messages after it.
          isNull(sourceRecords.withdrawnAt),
          ne(sourceRecords.id, before.messageId),
          lt(sourceRecords.occurredAt, before.sentAt),
          notSuperseded,
        ),
      )
      .orderBy(asc(items.createdAt), asc(itemKeys.itemKey));
    if (rows.length === 0) return [];
    const stated = await this.db
      .select({ ...foldable, itemId: revisions.itemId, originId: revisions.originId, sentAt: sourceRecords.occurredAt })
      .from(revisions)
      // Only a message's time decides whether it came before; other Revisions always count.
      .leftJoin(sourceRecords, and(eq(sourceRecords.id, revisions.originId), isNotNull(sourceRecords.body)))
      .where(and(inArray(revisions.itemId, rows.map((row) => row.id)), notSuperseded));
    // What the message itself and later ones stated is left out, as if they had not arrived yet.
    const earlier = stated.filter(({ originId, sentAt }) => !sentAt || (originId !== before.messageId && sentAt < before.sentAt));
    return rows.map((row) => ({
      itemKey: row.itemKey,
      kind: row.kind as ItemKind,
      folded: recompute(row.kind as ItemKind, earlier.filter(({ itemId }) => itemId === row.id) as FoldableRevision[]).folded,
    }));
  }

  async requestRereading(scope: { sourceId?: SourceId }): Promise<number> {
    const requested = await this.db
      .update(sourceRecords)
      .set({ processedAt: null })
      .where(
        and(
          isNotNull(sourceRecords.processedAt),
          isNotNull(sourceRecords.body),
          isNull(sourceRecords.withdrawnAt),
          scope.sourceId ? eq(sourceRecords.sourceId, scope.sourceId) : undefined,
        ),
      )
      .returning({ id: sourceRecords.id });
    return requested.length;
  }

  async pendingMessageCount(scope: { sourceId?: SourceId }): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sourceRecords)
      .where(and(pendingMessage, scope.sourceId ? eq(sourceRecords.sourceId, scope.sourceId) : undefined));
    return row?.count ?? 0;
  }

  async recordExtraction(extraction: Extraction, recompute: Recompute): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Only the first successful extraction counts, should two runs overlap.
      const [message] = await tx
        .update(sourceRecords)
        .set({ processedAt: extraction.at })
        .where(and(eq(sourceRecords.id, extraction.messageId), isNull(sourceRecords.processedAt)))
        .returning({ recordId: sourceRecords.id });
      if (!message) return;
      for (const { position, problem } of extraction.attachmentProblems) {
        await tx
          .update(sourceRecordAttachments)
          .set({ conversionProblem: problem })
          .where(and(eq(sourceRecordAttachments.recordId, extraction.messageId), eq(sourceRecordAttachments.position, position)));
      }
      const reached = new Map<ItemId, ItemKind>();
      const { sourceId, at } = extraction;
      // A re-read replaces what the message stated before (ADR-0015); the same Revision comes back.
      const superseded = await tx
        .update(revisions)
        .set({ accepted: false, rejection: "superseded" })
        .where(and(eq(revisions.originId, message.recordId), notSuperseded))
        .returning({ itemId: revisions.itemId });
      await noteReached(tx, superseded.map((row) => row.itemId as ItemId), reached);
      await this.append(tx, { sourceId, originId: message.recordId, at }, extraction.revisions, reached);
      await recomputeAll(tx, reached, recompute);
    });
  }

  async findMessage(id: RawMessageId): Promise<RawMessage | null> {
    if (!uuidPattern.test(id)) return null;
    const [row] = await this.db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.id, id));
    // A record without a body is no message, or one withdrawn.
    if (!row || row.body === null) return null;
    const attachments = await this.db
      .select()
      .from(sourceRecordAttachments)
      .where(eq(sourceRecordAttachments.recordId, id))
      .orderBy(asc(sourceRecordAttachments.position));
    return {
      id,
      sourceId: row.sourceId as SourceId,
      sentAt: row.occurredAt,
      attributes: row.attributes,
      body: row.body,
      attachments: attachments.map(({ position, filename, mediaType, size, blob, conversionProblem }) => ({
        position,
        filename,
        contentType: mediaType,
        size,
        blob: blob as BlobRef,
        conversionProblem,
      })),
    };
  }

  async overlapping(from: Date, to: Date | null): Promise<ProjectedItem[]> {
    return this.projected(and(to ? lte(items.windowFrom, to) : undefined, gte(items.windowTo, from)));
  }

  async outstanding(): Promise<ProjectedItem[]> {
    return this.projected(eq(items.outstanding, true));
  }

  async find(id: ItemId): Promise<ProjectedItem | null> {
    if (!uuidPattern.test(id)) return null;
    const [item] = await this.projected(eq(items.id, id));
    return item ?? null;
  }

  async appendAuthored(id: ItemId, revision: AuthoredRevision, recompute: Recompute): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [item] = await tx.select({ kind: items.kind }).from(items).where(eq(items.id, id));
      if (!item) return;
      const { author } = revision;
      await tx.insert(revisions).values({
        id: randomUUID(),
        itemId: id,
        // An Agenda's ticks are stored as `view`, as before it was renamed (see `storedRevisionAuthors`).
        author: author.kind === "agenda" ? "view" : author.kind,
        agendaId: author.kind === "agenda" ? author.agendaId : null,
        adminId: author.kind === "admin" ? author.adminId : null,
        act: revision.act,
        fields: revision.fields,
        sourceTime: revision.sourceTime,
        receivedAt: revision.sourceTime,
        accepted: true,
        rejection: null,
        evidence: null,
        // Only an Origin's Revisions are kept from being recorded twice; each tick counts.
        fingerprint: randomUUID(),
      });
      await recomputeAll(tx, new Map([[id, item.kind as ItemKind]]), recompute);
    });
  }

  async authoredRevisions(id: ItemId): Promise<AuthoredRevision[]> {
    if (!uuidPattern.test(id)) return [];
    const rows = await this.db
      .select()
      .from(revisions)
      .where(and(eq(revisions.itemId, id), inArray(revisions.author, ["view", "admin"])))
      .orderBy(asc(revisions.sequence));
    return rows.map((row) => ({
      act: row.act as Act,
      fields: row.fields,
      sourceTime: row.sourceTime,
      author:
        row.author === "view"
          ? { kind: "agenda", agendaId: row.agendaId as AgendaId | null }
          : { kind: "admin", adminId: row.adminId as AdminId | null },
    }));
  }

  /** The Items that match, with the links of their Origins, leaving out those of a hidden Source. */
  private async projected(where: SQL | undefined): Promise<ProjectedItem[]> {
    const rows = await this.db
      .select({ id: items.id, kind: items.kind, folded: items.folded })
      .from(items)
      .where(
        and(
          isNotNull(items.folded),
          where,
          // Items of a hidden Source stay recorded, but leave the timeline and the feeds.
          sql`NOT EXISTS (SELECT 1 FROM ${itemKeys} INNER JOIN ${sources} ON ${sources.id} = ${itemKeys.sourceId} WHERE ${itemKeys.itemId} = ${items.id} AND NOT ${sources.shown})`,
        ),
      )
      .orderBy(asc(items.windowFrom), asc(items.createdAt));
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const links = await this.db
      .selectDistinct({
        itemId: revisions.itemId,
        link: sourceRecords.link,
        sourceTypeId: sources.sourceTypeId,
        sourceName: sources.name,
        createdAt: sourceRecords.createdAt,
      })
      .from(revisions)
      .innerJoin(sourceRecords, eq(sourceRecords.id, revisions.originId))
      .innerJoin(sources, eq(sources.id, sourceRecords.sourceId))
      .where(and(inArray(revisions.itemId, ids), isNotNull(sourceRecords.link)))
      .orderBy(asc(sourceRecords.createdAt));
    const messages = await this.db
      .selectDistinct({
        itemId: revisions.itemId,
        id: sourceRecords.id,
        sourceTypeId: sources.sourceTypeId,
        sourceName: sources.name,
        sentAt: sourceRecords.occurredAt,
      })
      .from(revisions)
      .innerJoin(sourceRecords, eq(sourceRecords.id, revisions.originId))
      .innerJoin(sources, eq(sources.id, sourceRecords.sourceId))
      // A message whose Revisions were all rejected said nothing that shows.
      .where(and(inArray(revisions.itemId, ids), eq(revisions.accepted, true), isNotNull(sourceRecords.body)))
      .orderBy(asc(sourceRecords.occurredAt));
    // Only the Sources, and their Parts, of Origins whose statements count say whom the Item concerns.
    const sourcesOfItems = await this.db
      .selectDistinct({ itemId: revisions.itemId, sourceId: sourceRecords.sourceId, part: sourceRecords.part })
      .from(revisions)
      .innerJoin(sourceRecords, eq(sourceRecords.id, revisions.originId))
      .where(and(inArray(revisions.itemId, ids), eq(revisions.accepted, true)));
    return rows.flatMap((row) =>
      row.folded
        ? [
            {
              id: row.id as ItemId,
              kind: row.kind as ItemKind,
              folded: row.folded,
              links: links.flatMap(({ itemId, link, sourceTypeId, sourceName }) =>
                itemId === row.id && link ? [{ url: link, sourceTypeId: sourceTypeId as SourceTypeId, sourceName }] : [],
              ),
              messages: messages.flatMap(({ itemId, id, sourceTypeId, sourceName }) =>
                itemId === row.id ? [{ id: id as RawMessageId, sourceTypeId: sourceTypeId as SourceTypeId, sourceName }] : [],
              ),
              sources: sourcesOfItems.flatMap(({ itemId, sourceId, part }) => (itemId === row.id ? [{ sourceId: sourceId as SourceId, part }] : [])),
            },
          ]
        : [],
    );
  }

  /** Appends Revisions of one Origin, unless the same Revision is recorded; notes the Items they reach. */
  private async append(
    tx: Transaction,
    origin: { sourceId: SourceId; originId: string; at: Date },
    newRevisions: NewRevision[],
    reached: Map<ItemId, ItemKind>,
  ): Promise<void> {
    for (const revision of newRevisions) {
      const item = await this.itemFor(tx, origin, revision);
      const appended = await tx
        .insert(revisions)
        .values({
          id: randomUUID(),
          itemId: item.id,
          originId: origin.originId,
          act: revision.act,
          fields: revision.fields,
          sourceTime: revision.sourceTime,
          receivedAt: origin.at,
          accepted: revision.accepted,
          rejection: revision.rejection,
          evidence: revision.evidence,
          fingerprint: fingerprintOf(revision),
        })
        // A Revision a re-read superseded comes back when the message states it again, and one of
        // a withdrawn Source Record when it arrives again stating it.
        .onConflictDoUpdate({
          target: [revisions.originId, revisions.fingerprint],
          set: { accepted: revision.accepted, rejection: revision.rejection, evidence: revision.evidence },
          setWhere: inArray(revisions.rejection, ["superseded", "origin-withdrawn"]),
        })
        .returning({ id: revisions.id });
      if (appended.length > 0) reached.set(item.id, item.kind);
    }
  }

  /** The Item the Source's key names, created on the first Revision about it. */
  private async itemFor(
    tx: Transaction,
    origin: { sourceId: SourceId; at: Date },
    revision: NewRevision,
  ): Promise<{ id: ItemId; kind: ItemKind }> {
    const [known] = await tx
      .select({ id: items.id, kind: items.kind })
      .from(itemKeys)
      .innerJoin(items, eq(items.id, itemKeys.itemId))
      .where(and(eq(itemKeys.sourceId, origin.sourceId), eq(itemKeys.itemKey, revision.itemKey)));
    if (known) return { id: known.id as ItemId, kind: known.kind as ItemKind };
    const id = randomUUID() as ItemId;
    await tx.insert(items).values({ id, kind: revision.itemKind, createdAt: origin.at });
    await tx.insert(itemKeys).values({ sourceId: origin.sourceId, itemKey: revision.itemKey, itemId: id });
    return { id, kind: revision.itemKind };
  }
}

/** A message, with its text, waiting for its one successful extraction. */
const pendingMessage = and(isNull(sourceRecords.processedAt), isNotNull(sourceRecords.body), isNull(sourceRecords.withdrawnAt));

/** What `fold` needs of a Revision. */
const foldable = {
  act: revisions.act,
  fields: revisions.fields,
  sourceTime: revisions.sourceTime,
  sequence: revisions.sequence,
  accepted: revisions.accepted,
};

/** Leaves out the Revisions a re-read replaced. */
const notSuperseded = or(isNull(revisions.rejection), ne(revisions.rejection, "superseded"));

/** Notes the Items, with their kinds, in `reached`. */
async function noteReached(tx: Transaction, ids: ItemId[], reached: Map<ItemId, ItemKind>): Promise<void> {
  if (ids.length === 0) return;
  const kinds = await tx.select({ id: items.id, kind: items.kind }).from(items).where(inArray(items.id, [...new Set(ids)]));
  for (const item of kinds) reached.set(item.id as ItemId, item.kind as ItemKind);
}

/** Recomputes every reached Item from all its Revisions but the superseded ones. */
async function recomputeAll(tx: Transaction, reached: Map<ItemId, ItemKind>, recompute: Recompute): Promise<void> {
  for (const [id, kind] of reached) {
    // A superseded Revision counts as never stated, so that it does not remove the Item (ADR-0015).
    const all = await tx.select(foldable).from(revisions).where(and(eq(revisions.itemId, id), notSuperseded));
    const projection = recompute(kind, all as FoldableRevision[]);
    await tx
      .update(items)
      .set({
        folded: projection.folded,
        windowFrom: projection.window?.from ?? null,
        windowTo: projection.window?.to ?? null,
        outstanding: projection.outstanding,
      })
      .where(eq(items.id, id));
  }
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

/** What a Revision states, independent of the order a plugin wrote its fields in. */
function fingerprintOf(revision: NewRevision): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : typeof value === "object" && value !== null
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, inner]) => [key, canonical(inner)]),
          )
        : value;
  const statement = [revision.itemKey, revision.act, revision.sourceTime.toISOString(), canonical(revision.fields)];
  return createHash("sha256").update(JSON.stringify(statement)).digest("hex");
}
