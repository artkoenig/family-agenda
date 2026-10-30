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
  ViewRepository,
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
  View,
  ViewId,
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
  familyMembers,
  itemKeys,
  items,
  llmEndpoints,
  messageAttachments,
  origins,
  rawMessages,
  revisions,
  settings,
  signInFailures,
  sourceHealth,
  sourceMembers,
  sources,
  sourceTypes,
  viewPreselections,
  views,
} from "./schema";

/** Arbitrary key that serialises creating the first Admin. */
const setupLockKey = 7_342_002;

/** Reads and writes the one row of `settings`, which the schema creates (ADR-0013). */
export class PostgresFamilyRepository implements FamilyRepository {
  constructor(private readonly db: Database) {}

  async recoveryKitConfirmed(): Promise<boolean> {
    const [row] = await this.db.select({ at: settings.recoveryKitConfirmedAt }).from(settings);
    return row?.at != null;
  }

  async confirmRecoveryKit(at: Date): Promise<void> {
    await this.db
      .update(settings)
      .set({ recoveryKitConfirmedAt: sql`coalesce(${settings.recoveryKitConfirmedAt}, ${at})` });
  }

  async languages(): Promise<FamilyLanguages> {
    const [row] = await this.db
      .select({ language: settings.language, ocrLanguages: settings.ocrLanguages })
      .from(settings);
    if (!row) throw new Error("the settings row is missing");
    return {
      language: isFamilyLanguage(row.language) ? row.language : defaultFamilyLanguage,
      ocrLanguages: row.ocrLanguages as OcrLanguage[],
    };
  }

  async saveLanguages(languages: FamilyLanguages): Promise<void> {
    await this.db.update(settings).set({ language: languages.language, ocrLanguages: languages.ocrLanguages });
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

export class PostgresViewRepository implements ViewRepository {
  constructor(private readonly db: Database) {}

  async add(view: View): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(views).values(view);
      await insertPreselections(tx, view);
    });
  }

  async list(): Promise<View[]> {
    return this.select();
  }

  async findById(id: ViewId): Promise<View | null> {
    if (!uuidPattern.test(id)) return null;
    const [view] = await this.select(eq(views.id, id));
    return view ?? null;
  }

  async update(view: View): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(views).set({ horizonDays: view.horizonDays }).where(eq(views.id, view.id));
      await tx.delete(viewPreselections).where(eq(viewPreselections.viewId, view.id));
      await insertPreselections(tx, view);
    });
  }

  async remove(id: ViewId): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db.delete(views).where(eq(views.id, id));
  }

  private async select(where?: SQL): Promise<View[]> {
    const rows = await this.db
      .select({ view: views, familyMemberId: viewPreselections.familyMemberId })
      .from(views)
      .leftJoin(viewPreselections, eq(viewPreselections.viewId, views.id))
      .leftJoin(familyMembers, eq(familyMembers.id, viewPreselections.familyMemberId))
      .where(where)
      .orderBy(asc(views.position), asc(familyMembers.position));
    const byId = new Map<string, View>();
    for (const { view, familyMemberId } of rows) {
      const found = byId.get(view.id) ?? {
        id: view.id as ViewId,
        preselected: [],
        horizonDays: view.horizonDays,
        createdAt: view.createdAt,
      };
      if (familyMemberId) found.preselected.push(familyMemberId as FamilyMemberId);
      byId.set(view.id, found);
    }
    return [...byId.values()];
  }
}

async function insertPreselections(tx: Pick<Database, "insert">, view: View): Promise<void> {
  if (view.preselected.length === 0) return;
  await tx
    .insert(viewPreselections)
    .values(view.preselected.map((familyMemberId) => ({ viewId: view.id, familyMemberId })));
}

export class PostgresSourceTypeRepository implements SourceTypeRepository {
  constructor(private readonly db: Database) {}

  async recordDiscovered(ids: SourceTypeId[], applicationVersion: string, at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .insert(sourceTypes)
      .values(ids.map((id) => ({ id, firstSeenIn: applicationVersion, firstSeenAt: at })))
      .onConflictDoNothing({ target: sourceTypes.id });
  }

  async list(): Promise<SourceTypeRecord[]> {
    const rows = await this.db.select().from(sourceTypes).orderBy(asc(sourceTypes.id));
    return rows.map((row) => ({
      id: row.id as SourceTypeId,
      enabled: row.enabled,
      firstSeenIn: row.firstSeenIn,
      isNew: row.isNew,
    }));
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

  async markAllSeen(): Promise<void> {
    await this.db.update(sourceTypes).set({ isNew: false }).where(eq(sourceTypes.isNew, true));
  }
}

export class PostgresCatalogueRepository implements CatalogueRepository {
  constructor(private readonly db: Database) {}

  async recordDiscovered(sourceTypeId: SourceTypeId, entryIds: string[], applicationVersion: string, at: Date): Promise<void> {
    if (entryIds.length === 0) return;
    await this.db
      .insert(catalogueEntries)
      .values(entryIds.map((entryId) => ({ sourceTypeId, entryId, firstSeenIn: applicationVersion, firstSeenAt: at })))
      .onConflictDoNothing({ target: [catalogueEntries.sourceTypeId, catalogueEntries.entryId] });
  }

  async list(sourceTypeId: SourceTypeId): Promise<CatalogueRecord[]> {
    const rows = await this.db
      .select()
      .from(catalogueEntries)
      .where(eq(catalogueEntries.sourceTypeId, sourceTypeId))
      .orderBy(asc(catalogueEntries.entryId));
    return rows.map(({ entryId, enabled, firstSeenIn, pollIntervalSeconds }) => ({ entryId, enabled, firstSeenIn, pollIntervalSeconds }));
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
        state: source.state,
        pollIntervalSeconds: source.pollIntervalSeconds,
        shown: source.shown,
        name: source.name,
        createdAt: source.createdAt,
      });
      await tx.insert(sourceHealth).values({
        sourceId: source.id,
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
      await tx.update(sourceHealth).set({ lastRunAt: source.lastRunAt }).where(eq(sourceHealth.sourceId, source.id));
    });
  }

  async recordFailedRun(id: SourceId, at: Date, error: RunError): Promise<void> {
    await this.db
      .update(sourceHealth)
      .set({
        lastRunAt: at,
        failingSince: sql`coalesce(${sourceHealth.failingSince}, ${at})`,
        lastErrorKind: sql`CASE WHEN ${sourceHealth.lastErrorKind} = 'definite' THEN 'definite' ELSE ${error.kind} END`,
        lastError: error.message,
      })
      .where(eq(sourceHealth.sourceId, id));
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
      const originsOfSource = tx.select({ id: origins.id }).from(origins).where(eq(origins.sourceId, id));
      const texts = await tx
        .select({ blob: rawMessages.textBlob })
        .from(rawMessages)
        .where(inArray(rawMessages.originId, originsOfSource));
      const attachments = await tx
        .select({ blob: messageAttachments.blob })
        .from(messageAttachments)
        .where(inArray(messageAttachments.rawMessageId, originsOfSource));
      // The Items the Source names or stated something about; other Sources may name them too.
      const named = tx.select({ id: itemKeys.itemId }).from(itemKeys).where(eq(itemKeys.sourceId, id));
      const stated = tx.select({ id: revisions.itemId }).from(revisions).where(inArray(revisions.originId, originsOfSource));
      const reached = await tx
        .select({ id: items.id, kind: items.kind })
        .from(items)
        .where(or(inArray(items.id, named), inArray(items.id, stated)));
      // Removes its Origins with their messages and Revisions, and its Item keys, by cascade.
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
      return [...texts, ...attachments].map((row) => row.blob as BlobRef);
    });
  }

  private async select(where?: SQL): Promise<Source[]> {
    const rows = await this.db
      .select({ source: sources, health: sourceHealth })
      .from(sources)
      .innerJoin(sourceHealth, eq(sourceHealth.sourceId, sources.id))
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
    return rows.map(({ source, health }) => ({
      id: source.id as SourceId,
      sourceTypeId: source.sourceTypeId as SourceTypeId,
      plain: source.config,
      configVersion: source.configVersion,
      secrets: source.secretRefs as Record<string, SecretRef>,
      state: source.state,
      pollIntervalSeconds: source.pollIntervalSeconds,
      shown: source.shown,
      name: source.name,
      concerns: concernsOf(source.id),
      partConcerns: partConcernsOf(source.id),
      lastRunAt: health.lastRunAt,
      lastSuccessAt: health.lastSuccessAt,
      failure:
        health.failingSince && health.lastError !== null
          ? { kind: health.lastErrorKind === "definite" ? "definite" : "temporary", message: health.lastError, since: health.failingSince }
          : null,
      lastNewOriginAt: health.lastNewOriginAt,
      createdAt: source.createdAt,
    }));
  }
}

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
        const [row] = await tx
          .insert(origins)
          .values({
            id: randomUUID(),
            sourceId: run.sourceId,
            externalId: origin.externalId,
            attributes: origin.attributes,
            link: origin.link,
            part: origin.part,
            firstSeenAt: run.at,
          })
          .onConflictDoUpdate({
            target: [origins.sourceId, origins.externalId],
            // A later appearance without a link, such as a cancellation, keeps the link.
            set: { attributes: origin.attributes, link: sql`coalesce(excluded.link, ${origins.link})` },
            // A withdrawn Origin never comes back.
            setWhere: isNull(origins.withdrawnAt),
          })
          .returning({ id: origins.id });
        if (!row) {
          if (origin.message) knownMessages.push(origin.externalId);
          continue;
        }
        const { message } = origin;
        if (message) {
          const inserted = await tx
            .insert(rawMessages)
            .values({
              originId: row.id,
              thread: message.thread,
              sentAt: origin.occurredAt,
              textBlob: message.text.blob,
              textSha256: message.text.sha256,
              textSize: message.text.size,
              receivedAt: run.at,
            })
            .onConflictDoNothing({ target: rawMessages.originId })
            .returning({ originId: rawMessages.originId });
          if (inserted.length === 0) knownMessages.push(origin.externalId);
          else if (message.attachments.length > 0) {
            await tx.insert(messageAttachments).values(
              message.attachments.map((attachment, position) => ({
                rawMessageId: row.id,
                position,
                filename: attachment.filename,
                contentType: attachment.contentType,
                blob: attachment.blob,
                sha256: attachment.sha256,
                size: attachment.size,
              })),
            );
          }
        }
        await this.append(tx, { sourceId: run.sourceId, originId: row.id, at: run.at }, origin.revisions, reached);
      }
      const withdrawnFiles = await this.withdraw(tx, run, reached);
      await recomputeAll(tx, reached, recompute);
      await tx.update(sources).set({ state: run.state }).where(eq(sources.id, run.sourceId));
      const lastNewOrigin = tx
        .select({ at: sql`max(${origins.firstSeenAt})` })
        .from(origins)
        .where(eq(origins.sourceId, run.sourceId));
      await tx
        .update(sourceHealth)
        .set({
          lastRunAt: run.at,
          lastSuccessAt: run.at,
          ...failureColumns(null),
          lastNewOriginAt: sql`(${lastNewOrigin})`,
        })
        .where(eq(sourceHealth.sourceId, run.sourceId));
      return { knownMessages, withdrawnFiles };
    });
  }

  /**
   * Marks the Origins the Source deleted as withdrawn, rejects their Revisions and removes their
   * raw messages; notes the Items they reach. Returns the files of the removed messages.
   */
  private async withdraw(tx: Transaction, run: SourceRun, reached: Map<ItemId, ItemKind>): Promise<BlobRef[]> {
    if (run.withdrawn.length === 0) return [];
    const withdrawn = await tx
      .update(origins)
      .set({ withdrawnAt: run.at })
      .where(and(eq(origins.sourceId, run.sourceId), inArray(origins.externalId, run.withdrawn), isNull(origins.withdrawnAt)))
      .returning({ id: origins.id });
    if (withdrawn.length === 0) return [];
    const ids = withdrawn.map((row) => row.id);
    const rejected = await tx
      .update(revisions)
      .set({ accepted: false, rejection: "origin-withdrawn" })
      .where(and(inArray(revisions.originId, ids), eq(revisions.accepted, true)))
      .returning({ itemId: revisions.itemId });
    if (rejected.length > 0) {
      const kinds = await tx
        .select({ id: items.id, kind: items.kind })
        .from(items)
        .where(inArray(items.id, [...new Set(rejected.map((row) => row.itemId))]));
      for (const item of kinds) reached.set(item.id as ItemId, item.kind as ItemKind);
    }
    const attachments = await tx
      .select({ blob: messageAttachments.blob })
      .from(messageAttachments)
      .where(inArray(messageAttachments.rawMessageId, ids));
    // Removes their attachments by cascade.
    const texts = await tx.delete(rawMessages).where(inArray(rawMessages.originId, ids)).returning({ blob: rawMessages.textBlob });
    return [...texts, ...attachments].map((row) => row.blob as BlobRef);
  }

  async pendingMessages(limit: number): Promise<PendingMessage[]> {
    const rows = await this.db
      .select({
        id: rawMessages.originId,
        sourceId: origins.sourceId,
        externalId: origins.externalId,
        sentAt: rawMessages.sentAt,
        thread: rawMessages.thread,
        text: rawMessages.textBlob,
      })
      .from(rawMessages)
      .innerJoin(origins, eq(origins.id, rawMessages.originId))
      .where(isNull(rawMessages.extractedAt))
      .orderBy(asc(rawMessages.receivedAt), asc(rawMessages.sentAt))
      .limit(limit);
    const attachments =
      rows.length === 0
        ? []
        : await this.db
            .select()
            .from(messageAttachments)
            .where(inArray(messageAttachments.rawMessageId, rows.map((row) => row.id)))
            .orderBy(asc(messageAttachments.position));
    return rows.map((row) => ({
      ...row,
      id: row.id as RawMessageId,
      sourceId: row.sourceId as SourceId,
      text: row.text as BlobRef,
      attachments: attachments.flatMap((attachment) =>
        attachment.rawMessageId === row.id
          ? [{ position: attachment.position, filename: attachment.filename, contentType: attachment.contentType, blob: attachment.blob as BlobRef }]
          : [],
      ),
    }));
  }

  async itemsOfThread(sourceId: SourceId, thread: string): Promise<ThreadItem[]> {
    const rows = await this.db
      .selectDistinct({ itemKey: itemKeys.itemKey, kind: items.kind, folded: items.folded, createdAt: items.createdAt })
      .from(rawMessages)
      .innerJoin(revisions, eq(revisions.originId, rawMessages.originId))
      .innerJoin(items, eq(items.id, revisions.itemId))
      .innerJoin(origins, eq(origins.id, rawMessages.originId))
      .innerJoin(itemKeys, and(eq(itemKeys.itemId, items.id), eq(itemKeys.sourceId, origins.sourceId)))
      .where(and(eq(origins.sourceId, sourceId), eq(rawMessages.thread, thread)))
      .orderBy(asc(items.createdAt), asc(itemKeys.itemKey));
    return rows.map((row) => ({ itemKey: row.itemKey, kind: row.kind as ItemKind, folded: row.folded }));
  }

  async recordExtraction(extraction: Extraction, recompute: Recompute): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Only the first successful extraction counts, should two runs overlap.
      const [message] = await tx
        .update(rawMessages)
        .set({ extractedAt: extraction.at })
        .where(and(eq(rawMessages.originId, extraction.messageId), isNull(rawMessages.extractedAt)))
        .returning({ originId: rawMessages.originId });
      if (!message) return;
      for (const { position, problem } of extraction.attachmentProblems) {
        await tx
          .update(messageAttachments)
          .set({ conversionProblem: problem })
          .where(and(eq(messageAttachments.rawMessageId, extraction.messageId), eq(messageAttachments.position, position)));
      }
      const reached = new Map<ItemId, ItemKind>();
      const { sourceId, at } = extraction;
      await this.append(tx, { sourceId, originId: message.originId, at }, extraction.revisions, reached);
      await recomputeAll(tx, reached, recompute);
    });
  }

  async findMessage(id: RawMessageId): Promise<RawMessage | null> {
    if (!uuidPattern.test(id)) return null;
    const [row] = await this.db
      .select({ message: rawMessages, sourceId: origins.sourceId, attributes: origins.attributes })
      .from(rawMessages)
      .innerJoin(origins, eq(origins.id, rawMessages.originId))
      .where(eq(rawMessages.originId, id));
    if (!row) return null;
    const attachments = await this.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.rawMessageId, id))
      .orderBy(asc(messageAttachments.position));
    return {
      id,
      sourceId: row.sourceId as SourceId,
      sentAt: row.message.sentAt,
      attributes: row.attributes,
      text: row.message.textBlob as BlobRef,
      attachments: attachments.map(({ position, filename, contentType, size, blob, conversionProblem }) => ({
        position,
        filename,
        contentType,
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
        author: author.kind,
        viewId: author.kind === "view" ? author.viewId : null,
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
          ? { kind: "view", viewId: row.viewId as ViewId | null }
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
        link: origins.link,
        sourceTypeId: sources.sourceTypeId,
        sourceName: sources.name,
        firstSeenAt: origins.firstSeenAt,
      })
      .from(revisions)
      .innerJoin(origins, eq(origins.id, revisions.originId))
      .innerJoin(sources, eq(sources.id, origins.sourceId))
      .where(and(inArray(revisions.itemId, ids), isNotNull(origins.link)))
      .orderBy(asc(origins.firstSeenAt));
    const messages = await this.db
      .selectDistinct({
        itemId: revisions.itemId,
        id: rawMessages.originId,
        sourceTypeId: sources.sourceTypeId,
        sourceName: sources.name,
        sentAt: rawMessages.sentAt,
      })
      .from(revisions)
      .innerJoin(rawMessages, eq(rawMessages.originId, revisions.originId))
      .innerJoin(origins, eq(origins.id, revisions.originId))
      .innerJoin(sources, eq(sources.id, origins.sourceId))
      // A message whose Revisions were all rejected said nothing that shows.
      .where(and(inArray(revisions.itemId, ids), eq(revisions.accepted, true)))
      .orderBy(asc(rawMessages.sentAt));
    // Only the Sources, and their Parts, of Origins whose statements count say whom the Item concerns.
    const sourcesOfItems = await this.db
      .selectDistinct({ itemId: revisions.itemId, sourceId: origins.sourceId, part: origins.part })
      .from(revisions)
      .innerJoin(origins, eq(origins.id, revisions.originId))
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
        .onConflictDoNothing({ target: [revisions.originId, revisions.fingerprint] })
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

/** Recomputes every reached Item from all its Revisions. */
async function recomputeAll(tx: Transaction, reached: Map<ItemId, ItemKind>, recompute: Recompute): Promise<void> {
  for (const [id, kind] of reached) {
    const all = await tx
      .select({
        act: revisions.act,
        fields: revisions.fields,
        sourceTime: revisions.sourceTime,
        sequence: revisions.sequence,
        accepted: revisions.accepted,
      })
      .from(revisions)
      .where(eq(revisions.itemId, id));
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
      vision: row.vision,
      acknowledgedAt: row.acknowledgedAt,
      savedAt: row.savedAt,
    };
  }

  async save(endpoint: StoredLlmEndpoint): Promise<void> {
    const values = {
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      apiKeyRef: endpoint.apiKey,
      vision: endpoint.vision,
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
