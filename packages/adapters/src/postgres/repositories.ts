import { createHash, randomUUID } from "node:crypto";
import type {
  ActivityKind,
  ActivityRepository,
  AdminRepository,
  AdminSession,
  AdminSessionRepository,
  AttributionRuleRepository,
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
  Admin,
  AdminId,
  AttributionRule,
  AttributionRuleId,
  BlobRef,
  Email,
  FamilyId,
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
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { uuidPattern } from "../uuid";
import type { Database } from "./database";
import {
  admins,
  adminSessions,
  attributionRuleMembers,
  attributionRules,
  backgroundActivities,
  catalogueEntries,
  families,
  familyMembers,
  itemKeys,
  items,
  llmEndpoints,
  messageAttachments,
  origins,
  rawMessages,
  revisions,
  signInFailures,
  sources,
  sourceTypes,
  viewPreselections,
  views,
} from "./schema";

/** Arbitrary key that serialises creating the Family and the first Admin. */
const setupLockKey = 7_342_002;

export class PostgresFamilyRepository implements FamilyRepository {
  constructor(private readonly db: Database) {}

  async theFamily(): Promise<FamilyId> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${setupLockKey})`);
      const [existing] = await tx.select({ id: families.id }).from(families).limit(1);
      if (existing) return existing.id as FamilyId;
      const [created] = await tx.insert(families).values({}).returning({ id: families.id });
      if (!created) throw new Error("creating the Family returned no row");
      return created.id as FamilyId;
    });
  }

  async recoveryKitConfirmed(id: FamilyId): Promise<boolean> {
    const [row] = await this.db
      .select({ at: families.recoveryKitConfirmedAt })
      .from(families)
      .where(eq(families.id, id));
    return row?.at != null;
  }

  async confirmRecoveryKit(id: FamilyId, at: Date): Promise<void> {
    await this.db
      .update(families)
      .set({ recoveryKitConfirmedAt: sql`coalesce(${families.recoveryKitConfirmedAt}, ${at})` })
      .where(eq(families.id, id));
  }

  async languages(id: FamilyId): Promise<FamilyLanguages> {
    const [row] = await this.db
      .select({ language: families.language, ocrLanguages: families.ocrLanguages })
      .from(families)
      .where(eq(families.id, id));
    if (!row) throw new Error(`no Family ${id}`);
    return {
      language: isFamilyLanguage(row.language) ? row.language : defaultFamilyLanguage,
      ocrLanguages: row.ocrLanguages as OcrLanguage[],
    };
  }

  async saveLanguages(id: FamilyId, languages: FamilyLanguages): Promise<void> {
    await this.db
      .update(families)
      .set({ language: languages.language, ocrLanguages: languages.ocrLanguages })
      .where(eq(families.id, id));
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

  async list(familyId: FamilyId): Promise<Admin[]> {
    const rows = await this.db
      .select()
      .from(admins)
      .where(eq(admins.familyId, familyId))
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
    familyId: row.familyId as FamilyId,
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

  async list(familyId: FamilyId): Promise<FamilyMember[]> {
    const rows = await this.db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.familyId, familyId))
      .orderBy(asc(familyMembers.position));
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
    familyId: row.familyId as FamilyId,
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

  async list(familyId: FamilyId): Promise<View[]> {
    return this.select(eq(views.familyId, familyId));
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

  private async select(where: SQL): Promise<View[]> {
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
        familyId: view.familyId as FamilyId,
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

export class PostgresAttributionRuleRepository implements AttributionRuleRepository {
  constructor(private readonly db: Database) {}

  async add(rule: AttributionRule): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(attributionRules)
        .values({ ...rule, wholeFamily: rule.concerns === "whole-family" })
        .onConflictDoNothing({ target: [attributionRules.sourceId, attributionRules.attribute, attributionRules.value] })
        .returning({ id: attributionRules.id });
      if (inserted.length === 0) return false;
      await insertRuleMembers(tx, rule);
      return true;
    });
  }

  async list(familyId: FamilyId): Promise<AttributionRule[]> {
    return this.select(eq(attributionRules.familyId, familyId));
  }

  async findById(id: AttributionRuleId): Promise<AttributionRule | null> {
    if (!uuidPattern.test(id)) return null;
    const [rule] = await this.select(eq(attributionRules.id, id));
    return rule ?? null;
  }

  async update(rule: AttributionRule): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ id: attributionRules.id })
        .from(attributionRules)
        .where(
          and(
            eq(attributionRules.sourceId, rule.sourceId),
            eq(attributionRules.attribute, rule.attribute),
            eq(attributionRules.value, rule.value),
            sql`${attributionRules.id} <> ${rule.id}`,
          ),
        );
      if (taken) return false;
      await tx
        .update(attributionRules)
        .set({ value: rule.value, wholeFamily: rule.concerns === "whole-family" })
        .where(eq(attributionRules.id, rule.id));
      await tx.delete(attributionRuleMembers).where(eq(attributionRuleMembers.ruleId, rule.id));
      await insertRuleMembers(tx, rule);
      return true;
    });
  }

  async remove(id: AttributionRuleId): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db.delete(attributionRules).where(eq(attributionRules.id, id));
  }

  async seenValues(sourceId: SourceId, attribute: string): Promise<string[]> {
    if (!uuidPattern.test(sourceId)) return [];
    const value = sql<string>`${origins.attributes} ->> ${attribute}`;
    const rows = await this.db
      .selectDistinct({ value })
      .from(origins)
      .where(and(eq(origins.sourceId, sourceId), sql`${origins.attributes} ? ${attribute}`));
    return rows.map((row) => row.value).sort();
  }

  private async select(where: SQL): Promise<AttributionRule[]> {
    const rows = await this.db
      .select({ rule: attributionRules, familyMemberId: attributionRuleMembers.familyMemberId })
      .from(attributionRules)
      .leftJoin(attributionRuleMembers, eq(attributionRuleMembers.ruleId, attributionRules.id))
      .leftJoin(familyMembers, eq(familyMembers.id, attributionRuleMembers.familyMemberId))
      .where(where)
      .orderBy(asc(attributionRules.position), asc(familyMembers.position));
    const byId = new Map<string, AttributionRule>();
    for (const { rule, familyMemberId } of rows) {
      const found = byId.get(rule.id) ?? {
        id: rule.id as AttributionRuleId,
        familyId: rule.familyId as FamilyId,
        sourceId: rule.sourceId as SourceId,
        attribute: rule.attribute,
        value: rule.value,
        concerns: rule.wholeFamily ? "whole-family" : [],
        createdAt: rule.createdAt,
      };
      if (familyMemberId && found.concerns !== "whole-family") found.concerns.push(familyMemberId as FamilyMemberId);
      byId.set(rule.id, found);
    }
    return [...byId.values()];
  }
}

async function insertRuleMembers(tx: Pick<Database, "insert">, rule: AttributionRule): Promise<void> {
  if (rule.concerns === "whole-family" || rule.concerns.length === 0) return;
  await tx
    .insert(attributionRuleMembers)
    .values(rule.concerns.map((familyMemberId) => ({ ruleId: rule.id, familyMemberId })));
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
    await this.db.insert(sources).values({
      id: source.id,
      familyId: source.familyId,
      sourceTypeId: source.sourceTypeId,
      config: source.plain,
      configVersion: source.configVersion,
      secretRefs: source.secrets,
      state: source.state,
      pollIntervalSeconds: source.pollIntervalSeconds,
      shown: source.shown,
      name: source.name,
      lastRunAt: source.lastRunAt,
      lastSuccessAt: source.lastSuccessAt,
      ...failureColumns(source.failure),
      lastNewOriginAt: source.lastNewOriginAt,
      createdAt: source.createdAt,
    });
  }

  async list(familyId: FamilyId): Promise<Source[]> {
    return this.select(eq(sources.familyId, familyId));
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
    await this.db
      .update(sources)
      .set({
        config: source.plain,
        configVersion: source.configVersion,
        secretRefs: source.secrets,
        pollIntervalSeconds: source.pollIntervalSeconds,
        lastRunAt: source.lastRunAt,
      })
      .where(eq(sources.id, source.id));
  }

  async recordFailedRun(id: SourceId, at: Date, error: RunError): Promise<void> {
    await this.db
      .update(sources)
      .set({
        lastRunAt: at,
        failingSince: sql`coalesce(${sources.failingSince}, ${at})`,
        lastErrorKind: sql`CASE WHEN ${sources.lastErrorKind} = 'definite' THEN 'definite' ELSE ${error.kind} END`,
        lastError: error.message,
      })
      .where(eq(sources.id, id));
  }

  async setShown(id: SourceId, shown: boolean): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db.update(sources).set({ shown }).where(eq(sources.id, id));
  }

  async rename(id: SourceId, name: string | null): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db.update(sources).set({ name }).where(eq(sources.id, id));
  }

  async remove(id: SourceId): Promise<BlobRef[]> {
    if (!uuidPattern.test(id)) return [];
    return this.db.transaction(async (tx) => {
      const keyed = await tx.select({ id: itemKeys.itemId }).from(itemKeys).where(eq(itemKeys.sourceId, id));
      const itemIds = keyed.map((row) => row.id);
      const originsOfSource = tx.select({ id: origins.id }).from(origins).where(eq(origins.sourceId, id));
      const messagesOfSource = tx.select({ id: rawMessages.id }).from(rawMessages).where(eq(rawMessages.sourceId, id));
      const attachments = await tx
        .delete(messageAttachments)
        .where(inArray(messageAttachments.rawMessageId, messagesOfSource))
        .returning({ blob: messageAttachments.blob });
      const texts = await tx.delete(rawMessages).where(eq(rawMessages.sourceId, id)).returning({ blob: rawMessages.textBlob });
      await tx
        .delete(revisions)
        .where(or(inArray(revisions.originId, originsOfSource), itemIds.length > 0 ? inArray(revisions.itemId, itemIds) : undefined));
      await tx.delete(itemKeys).where(eq(itemKeys.sourceId, id));
      if (itemIds.length > 0) await tx.delete(items).where(inArray(items.id, itemIds));
      await tx.delete(origins).where(eq(origins.sourceId, id));
      await tx.delete(sources).where(eq(sources.id, id));
      return [...texts, ...attachments].map((row) => row.blob as BlobRef);
    });
  }

  private async select(where: SQL): Promise<Source[]> {
    const rows = await this.db.select().from(sources).where(where).orderBy(asc(sources.position));
    return rows.map((row) => ({
      id: row.id as SourceId,
      familyId: row.familyId as FamilyId,
      sourceTypeId: row.sourceTypeId as SourceTypeId,
      plain: row.config,
      configVersion: row.configVersion,
      secrets: row.secretRefs as Record<string, SecretRef>,
      state: row.state,
      pollIntervalSeconds: row.pollIntervalSeconds,
      shown: row.shown,
      name: row.name,
      lastRunAt: row.lastRunAt,
      lastSuccessAt: row.lastSuccessAt,
      failure:
        row.failingSince && row.lastError !== null
          ? { kind: row.lastErrorKind === "definite" ? "definite" : "temporary", message: row.lastError, since: row.failingSince }
          : null,
      lastNewOriginAt: row.lastNewOriginAt,
      createdAt: row.createdAt,
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
            familyId: run.familyId,
            sourceId: run.sourceId,
            externalId: origin.externalId,
            attributes: origin.attributes,
            link: origin.link,
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
          const id = randomUUID();
          const inserted = await tx
            .insert(rawMessages)
            .values({
              id,
              familyId: run.familyId,
              originId: row.id,
              sourceId: run.sourceId,
              thread: message.thread,
              sentAt: origin.occurredAt,
              textBlob: message.text.blob,
              textSha256: message.text.sha256,
              textSize: message.text.size,
              receivedAt: run.at,
            })
            .onConflictDoNothing({ target: rawMessages.originId })
            .returning({ id: rawMessages.id });
          if (inserted.length === 0) knownMessages.push(origin.externalId);
          else if (message.attachments.length > 0) {
            await tx.insert(messageAttachments).values(
              message.attachments.map((attachment, position) => ({
                id: randomUUID(),
                rawMessageId: id,
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
        await this.append(tx, { familyId: run.familyId, sourceId: run.sourceId, originId: row.id, at: run.at }, origin.revisions, reached);
      }
      const withdrawnFiles = await this.withdraw(tx, run, reached);
      await this.recomputeAll(tx, reached, recompute);
      const lastNewOrigin = tx
        .select({ at: sql`max(${origins.firstSeenAt})` })
        .from(origins)
        .where(eq(origins.sourceId, run.sourceId));
      await tx
        .update(sources)
        .set({
          state: run.state,
          lastRunAt: run.at,
          lastSuccessAt: run.at,
          ...failureColumns(null),
          lastNewOriginAt: sql`(${lastNewOrigin})`,
        })
        .where(eq(sources.id, run.sourceId));
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
    const messages = tx.select({ id: rawMessages.id }).from(rawMessages).where(inArray(rawMessages.originId, ids));
    const attachments = await tx
      .delete(messageAttachments)
      .where(inArray(messageAttachments.rawMessageId, messages))
      .returning({ blob: messageAttachments.blob });
    const texts = await tx.delete(rawMessages).where(inArray(rawMessages.originId, ids)).returning({ blob: rawMessages.textBlob });
    return [...texts, ...attachments].map((row) => row.blob as BlobRef);
  }

  async pendingMessages(limit: number): Promise<PendingMessage[]> {
    const rows = await this.db
      .select({
        id: rawMessages.id,
        familyId: rawMessages.familyId,
        sourceId: rawMessages.sourceId,
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
      familyId: row.familyId as FamilyId,
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
      .innerJoin(itemKeys, and(eq(itemKeys.itemId, items.id), eq(itemKeys.sourceId, rawMessages.sourceId)))
      .where(and(eq(rawMessages.sourceId, sourceId), eq(rawMessages.thread, thread)))
      .orderBy(asc(items.createdAt), asc(itemKeys.itemKey));
    return rows.map((row) => ({ itemKey: row.itemKey, kind: row.kind as ItemKind, folded: row.folded }));
  }

  async recordExtraction(extraction: Extraction, recompute: Recompute): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Only the first successful extraction counts, should two runs overlap.
      const [message] = await tx
        .update(rawMessages)
        .set({ extractedAt: extraction.at })
        .where(and(eq(rawMessages.id, extraction.messageId), isNull(rawMessages.extractedAt)))
        .returning({ originId: rawMessages.originId });
      if (!message) return;
      for (const { position, problem } of extraction.attachmentProblems) {
        await tx
          .update(messageAttachments)
          .set({ conversionProblem: problem })
          .where(and(eq(messageAttachments.rawMessageId, extraction.messageId), eq(messageAttachments.position, position)));
      }
      const reached = new Map<ItemId, ItemKind>();
      const { familyId, sourceId, at } = extraction;
      await this.append(tx, { familyId, sourceId, originId: message.originId, at }, extraction.revisions, reached);
      await this.recomputeAll(tx, reached, recompute);
    });
  }

  async findMessage(id: RawMessageId): Promise<RawMessage | null> {
    if (!uuidPattern.test(id)) return null;
    const [row] = await this.db
      .select({ message: rawMessages, attributes: origins.attributes })
      .from(rawMessages)
      .innerJoin(origins, eq(origins.id, rawMessages.originId))
      .where(eq(rawMessages.id, id));
    if (!row) return null;
    const attachments = await this.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.rawMessageId, id))
      .orderBy(asc(messageAttachments.position));
    return {
      id,
      sourceId: row.message.sourceId as SourceId,
      sentAt: row.message.sentAt,
      attributes: row.attributes,
      text: row.message.textBlob as BlobRef,
      attachments: attachments.map(({ filename, contentType, size, blob, conversionProblem }) => ({
        filename,
        contentType,
        size,
        blob: blob as BlobRef,
        conversionProblem,
      })),
    };
  }

  async overlapping(familyId: FamilyId, from: Date, to: Date | null): Promise<ProjectedItem[]> {
    const rows = await this.db
      .select({ id: items.id, kind: items.kind, folded: items.folded })
      .from(items)
      .where(
        and(
          eq(items.familyId, familyId),
          isNotNull(items.folded),
          to ? lte(items.windowFrom, to) : undefined,
          gte(items.windowTo, from),
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
        id: rawMessages.id,
        sourceTypeId: sources.sourceTypeId,
        sentAt: rawMessages.sentAt,
      })
      .from(revisions)
      .innerJoin(rawMessages, eq(rawMessages.originId, revisions.originId))
      .innerJoin(origins, eq(origins.id, revisions.originId))
      .innerJoin(sources, eq(sources.id, origins.sourceId))
      // A message whose Revisions were all rejected said nothing that shows.
      .where(and(inArray(revisions.itemId, ids), eq(revisions.accepted, true)))
      .orderBy(asc(rawMessages.sentAt));
    // Only what an Origin stated that counts says whom the Item concerns.
    const originsOfItems = await this.db
      .selectDistinct({ itemId: revisions.itemId, sourceId: origins.sourceId, attributes: origins.attributes })
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
              links: links.flatMap(({ itemId, link, sourceTypeId }) =>
                itemId === row.id && link ? [{ url: link, sourceTypeId: sourceTypeId as SourceTypeId }] : [],
              ),
              messages: messages.flatMap(({ itemId, id, sourceTypeId }) =>
                itemId === row.id ? [{ id: id as RawMessageId, sourceTypeId: sourceTypeId as SourceTypeId }] : [],
              ),
              origins: originsOfItems.flatMap(({ itemId, sourceId, attributes }) =>
                itemId === row.id ? [{ sourceId: sourceId as SourceId, attributes }] : [],
              ),
            },
          ]
        : [],
    );
  }

  /** Appends Revisions of one Origin, unless the same Revision is recorded; notes the Items they reach. */
  private async append(
    tx: Transaction,
    origin: { familyId: FamilyId; sourceId: SourceId; originId: string; at: Date },
    newRevisions: NewRevision[],
    reached: Map<ItemId, ItemKind>,
  ): Promise<void> {
    for (const revision of newRevisions) {
      const item = await this.itemFor(tx, origin, revision);
      const appended = await tx
        .insert(revisions)
        .values({
          id: randomUUID(),
          familyId: origin.familyId,
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

  /** Recomputes every reached Item from all its Revisions. */
  private async recomputeAll(tx: Transaction, reached: Map<ItemId, ItemKind>, recompute: Recompute): Promise<void> {
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
        })
        .where(eq(items.id, id));
    }
  }

  /** The Item the Source's key names, created on the first Revision about it. */
  private async itemFor(
    tx: Transaction,
    origin: { familyId: FamilyId; sourceId: SourceId; at: Date },
    revision: NewRevision,
  ): Promise<{ id: ItemId; kind: ItemKind }> {
    const [known] = await tx
      .select({ id: items.id, kind: items.kind })
      .from(itemKeys)
      .innerJoin(items, eq(items.id, itemKeys.itemId))
      .where(and(eq(itemKeys.sourceId, origin.sourceId), eq(itemKeys.itemKey, revision.itemKey)));
    if (known) return { id: known.id as ItemId, kind: known.kind as ItemKind };
    const id = randomUUID() as ItemId;
    await tx.insert(items).values({ id, familyId: origin.familyId, kind: revision.itemKind, createdAt: origin.at });
    await tx.insert(itemKeys).values({ sourceId: origin.sourceId, itemKey: revision.itemKey, itemId: id });
    return { id, kind: revision.itemKind };
  }
}

export class PostgresLlmEndpointRepository implements LlmEndpointRepository {
  constructor(private readonly db: Database) {}

  async find(familyId: FamilyId): Promise<StoredLlmEndpoint | null> {
    const [row] = await this.db.select().from(llmEndpoints).where(eq(llmEndpoints.familyId, familyId));
    if (!row) return null;
    return {
      familyId,
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
      .values({ familyId: endpoint.familyId, ...values })
      .onConflictDoUpdate({ target: llmEndpoints.familyId, set: values });
  }
}

export class PostgresActivityRepository implements ActivityRepository {
  constructor(private readonly db: Database) {}

  async find(familyId: FamilyId): Promise<BackgroundActivity | null> {
    const [row] = await this.db.select().from(backgroundActivities).where(eq(backgroundActivities.familyId, familyId));
    if (!row) return null;
    return { kind: row.kind as ActivityKind, done: row.done, total: row.total, updatedAt: row.updatedAt };
  }

  async save(familyId: FamilyId, activity: BackgroundActivity): Promise<void> {
    await this.db
      .insert(backgroundActivities)
      .values({ familyId, ...activity })
      .onConflictDoUpdate({ target: backgroundActivities.familyId, set: activity });
  }

  async clear(familyId: FamilyId): Promise<void> {
    await this.db.delete(backgroundActivities).where(eq(backgroundActivities.familyId, familyId));
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
