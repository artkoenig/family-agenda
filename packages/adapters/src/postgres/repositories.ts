import { createHash, randomUUID } from "node:crypto";
import type {
  AdminRepository,
  AdminSession,
  AdminSessionRepository,
  FamilyMemberRepository,
  FamilyRepository,
  ItemProjection,
  ItemRepository,
  NewRevision,
  PlainConfig,
  ProjectedItem,
  SecretRef,
  SignInFailureLog,
  Source,
  SourceRepository,
  SourceRun,
  SourceTypeRecord,
  SourceTypeRepository,
  ViewRepository,
} from "@family-butler/application";
import type {
  Admin,
  AdminId,
  BlobRef,
  Email,
  FamilyId,
  FamilyMember,
  FamilyMemberId,
  FoldableRevision,
  ItemId,
  ItemKind,
  PhotoType,
  SourceId,
  SourceTypeId,
  View,
  ViewId,
} from "@family-butler/domain";
import { and, asc, eq, gt, gte, inArray, isNotNull, lt, lte, sql, type SQL } from "drizzle-orm";
import { uuidPattern } from "../uuid";
import type { Database } from "./database";
import {
  admins,
  adminSessions,
  families,
  familyMembers,
  itemKeys,
  items,
  origins,
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
      lastRunAt: source.lastRunAt,
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
      })
      .where(eq(sources.id, source.id));
  }

  async recordFailedRun(id: SourceId, at: Date): Promise<void> {
    await this.db.update(sources).set({ lastRunAt: at }).where(eq(sources.id, id));
  }

  async remove(id: SourceId): Promise<void> {
    if (!uuidPattern.test(id)) return;
    await this.db.delete(sources).where(eq(sources.id, id));
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
      lastRunAt: row.lastRunAt,
      createdAt: row.createdAt,
    }));
  }
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class PostgresItemRepository implements ItemRepository {
  constructor(private readonly db: Database) {}

  async recordRun(
    run: SourceRun,
    recompute: (kind: ItemKind, revisions: FoldableRevision[]) => ItemProjection,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const reached = new Map<ItemId, ItemKind>();
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
          })
          .returning({ id: origins.id });
        if (!row) throw new Error("recording the Origin returned no row");
        for (const revision of origin.revisions) {
          const item = await this.itemFor(tx, run, revision);
          const appended = await tx
            .insert(revisions)
            .values({
              id: randomUUID(),
              familyId: run.familyId,
              itemId: item.id,
              originId: row.id,
              act: revision.act,
              fields: revision.fields,
              sourceTime: revision.sourceTime,
              receivedAt: run.at,
              accepted: revision.accepted,
              fingerprint: fingerprintOf(revision),
            })
            .onConflictDoNothing({ target: [revisions.originId, revisions.fingerprint] })
            .returning({ id: revisions.id });
          if (appended.length > 0) reached.set(item.id, item.kind);
        }
      }
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
      await tx.update(sources).set({ state: run.state, lastRunAt: run.at }).where(eq(sources.id, run.sourceId));
    });
  }

  async overlapping(familyId: FamilyId, from: Date, to: Date): Promise<ProjectedItem[]> {
    const rows = await this.db
      .select({ id: items.id, kind: items.kind, folded: items.folded })
      .from(items)
      .where(
        and(eq(items.familyId, familyId), isNotNull(items.folded), lte(items.windowFrom, to), gte(items.windowTo, from)),
      )
      .orderBy(asc(items.windowFrom), asc(items.createdAt));
    if (rows.length === 0) return [];
    const links = await this.db
      .selectDistinct({ itemId: revisions.itemId, link: origins.link, firstSeenAt: origins.firstSeenAt })
      .from(revisions)
      .innerJoin(origins, eq(origins.id, revisions.originId))
      .where(and(inArray(revisions.itemId, rows.map((row) => row.id)), isNotNull(origins.link)))
      .orderBy(asc(origins.firstSeenAt));
    return rows.flatMap((row) =>
      row.folded
        ? [
            {
              id: row.id as ItemId,
              kind: row.kind as ItemKind,
              folded: row.folded,
              links: links.flatMap((link) => (link.itemId === row.id && link.link ? [link.link] : [])),
            },
          ]
        : [],
    );
  }

  /** The Item the Source's key names, created on the first Revision about it. */
  private async itemFor(
    tx: Transaction,
    run: SourceRun,
    revision: NewRevision,
  ): Promise<{ id: ItemId; kind: ItemKind }> {
    const [known] = await tx
      .select({ id: items.id, kind: items.kind })
      .from(itemKeys)
      .innerJoin(items, eq(items.id, itemKeys.itemId))
      .where(and(eq(itemKeys.sourceId, run.sourceId), eq(itemKeys.itemKey, revision.itemKey)));
    if (known) return { id: known.id as ItemId, kind: known.kind as ItemKind };
    const id = randomUUID() as ItemId;
    await tx.insert(items).values({ id, familyId: run.familyId, kind: revision.itemKind, createdAt: run.at });
    await tx.insert(itemKeys).values({ sourceId: run.sourceId, itemKey: revision.itemKey, itemId: id });
    return { id, kind: revision.itemKind };
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
