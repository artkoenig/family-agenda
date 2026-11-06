import type { Application } from "@family-agenda/api/composition-root";
import type { AgendaId, FamilyMemberId, SourceAttributeId } from "@family-agenda/domain";

/** Who signs in to the Admin area of a preview. Public on purpose: a preview holds no real data. */
export const demoAdmin = { email: "admin@example.org", password: "preview-password" } as const;

export type SeededAgenda = { id: AgendaId; audience: string };

export type SeedResult = { ok: true; admin: typeof demoAdmin; agendas: SeededAgenda[] } | { ok: false; problem: string };

const demoMembers = ["Anna", "Ben", "Emma", "Noah"];

/** The Source Attributes of the demo Source (see `demoAttributes` there) that concern one Family Member each; the family calendar concerns no one in particular. */
const attributeOwners = { "school-emma": "Emma", "club-noah": "Noah" };

/** The Agendas of the demo: one for the whole Family, none naming a member, one for each child, and the Family's Task List. */
const demoAgendas = [
  { audience: "the Family", member: null, layout: "timeline" },
  { audience: "Emma", member: "Emma", layout: "timeline" },
  { audience: "Noah", member: "Noah", layout: "timeline" },
  { audience: "the Family's Tasks", member: null, layout: "task_list" },
] as const;

class SeedProblem extends Error {}

/** What a use case answered when it succeeded; a refusal ends the seeding with its problem. */
function succeeded<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new SeedProblem(String((result as { problem?: unknown }).problem));
  return result as Extract<T, { ok: true }>;
}

/**
 * Fills a fresh Instance with a made-up Family for trying out a change: an Admin, four Family
 * Members, the demo Source (which states a week of Events and Lessons and two Tasks, ADR-0016),
 * assigned to them, and an Agenda for the whole Family and for each child, and a Task List. It goes through the same use cases
 * as the Admin area, so what it writes is what the Instance itself would write. The demo Source
 * plugin must be installed in the Instance already.
 *
 * It imports types only: a preview runs it inside the container of the pull request's code, which
 * may predate this tool, so nothing here may need a package that code lacks.
 */
export async function seedDemoFamily(app: Application): Promise<SeedResult> {
  try {
    succeeded(await app.admins.createFirstAdmin({ ...demoAdmin, language: "en" }));
    const members = await addMembers(app);
    await bringInDemoSource(app, members);
    return { ok: true, admin: demoAdmin, agendas: await createAgendas(app, members) };
  } catch (error) {
    if (error instanceof SeedProblem) return { ok: false, problem: error.message };
    throw error;
  }
}

async function addMembers(app: Application): Promise<Map<string, FamilyMemberId>> {
  const ids = new Map<string, FamilyMemberId>();
  for (const name of demoMembers) ids.set(name, succeeded(await app.familyMembers.add({ name })).id);
  return ids;
}

/** Adds the demo Source, whose first run declares its Source Attributes and brings in the Items (the worker repeats it hourly), and assigns them. */
async function bringInDemoSource(app: Application, members: Map<string, FamilyMemberId>): Promise<void> {
  succeeded(await app.sourceTypes.enable("demo"));
  succeeded(await app.sources.add({ sourceTypeId: "demo", plain: {}, secrets: {} }));
  await app.polling.pollDue();
  const declared = new Map((await app.sources.list()).flatMap((listed) => listed.attributes.map((attribute) => [attribute.externalId, attribute.id] as const)));
  for (const [externalId, owner] of Object.entries(attributeOwners)) {
    succeeded(await app.sources.assignAttribute(declared.get(externalId) as SourceAttributeId, [members.get(owner) as FamilyMemberId]));
  }
}

async function createAgendas(app: Application, members: Map<string, FamilyMemberId>): Promise<SeededAgenda[]> {
  const agendas: SeededAgenda[] = [];
  for (const { audience, member, layout } of demoAgendas) {
    const memberIds = member === null ? [] : [members.get(member) as FamilyMemberId];
    agendas.push({ id: succeeded(await app.agendas.create({ layout, memberIds, horizonDays: 7 })).id, audience });
  }
  return agendas;
}
