import type {
  AdminRepository,
  AdminSession,
  AdminSessionRepository,
  FamilyMemberRepository,
  FamilyRepository,
  SignInFailureLog,
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
  PhotoType,
  View,
  ViewId,
} from "@family-butler/domain";
import { and, asc, eq, gt, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { Database } from "./database";
import {
  admins,
  adminSessions,
  families,
  familyMembers,
  signInFailures,
  viewPreselections,
  views,
} from "./schema";

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
