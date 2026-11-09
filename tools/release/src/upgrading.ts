/** What decides how an upgrade goes, as it stands at one release. */
export type Snapshot = {
  /** The SQL migrations in `packages/adapters/drizzle/`, by file name. */
  migrations: Record<string, string>;
  /** The text of `compose.yaml`. */
  compose: string;
  /** Whether Source plugins run in-process, as before plugin containers (ADR-0001). */
  inProcessPlugins: boolean;
};

/** Statements that take data away, which a Family should read about before it upgrades. */
const removesData = /\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i;

/** SQL without its line comments, which drizzle-kit fills with `--> statement-breakpoint` and notes. */
const withoutComments = (sql: string) =>
  sql
    .split("\n")
    .map((line) => line.split("--")[0])
    .join("\n");

const names = (migrations: Snapshot["migrations"]) => Object.keys(migrations);
/** The first few files by name, then how many more there are, so that a squash stays one line. */
const shown = 3;
const list = (files: string[]) =>
  [...files.slice(0, shown).map((file) => `\`${file}\``), ...(files.length > shown ? [`${files.length - shown} more`] : [])].join(", ");

/** Migrations that were there before and are gone or different now, and the ones that are new. */
function changedMigrations(before: Snapshot["migrations"], after: Snapshot["migrations"]) {
  return {
    rewritten: names(before).filter((name) => after[name] !== before[name]).sort(),
    added: names(after).filter((name) => !(name in before)).sort(),
  };
}

function dataLines(before: Snapshot["migrations"], after: Snapshot["migrations"], docs: string): string[] {
  const { rewritten, added } = changedMigrations(before, after);
  if (rewritten.length > 0) {
    return [
      `**Start over required.** The data model changed in a way that cannot be migrated: ${list(rewritten)} changed or was removed. See [Start over](${docs}#start-over).`,
    ];
  }
  if (added.length === 0) return ["**Data is kept.**"];
  const removing = added.filter((name) => removesData.test(withoutComments(after[name] ?? "")));
  return [
    "**Data is kept.** The database is migrated when the Instance starts.",
    ...removing.map((name) => `This migration removes data: \`${name}\`. Make a backup first, see [Back up](${docs}#back-up).`),
  ];
}

/** The major version of the Postgres image in `compose.yaml`, such as 17 for `postgres:17`. */
export function postgresMajorOf(compose: string): number | null {
  const major = /^[ \t]*image:[ \t]*postgres:(\d+)/m.exec(compose)?.[1];
  return major === undefined ? null : Number(major);
}

function postgresLines(before: string, after: string, docs: string): string[] {
  const [from, to] = [postgresMajorOf(before), postgresMajorOf(after)];
  if (from === null || to === null || from === to) return [];
  return [
    `**Postgres major upgrade: dump and restore required.** The Postgres version changed from ${from} to ${to}. Back up with the old version running, then see [Restore](${docs}#restore).`,
  ];
}

/** The release that moves Source plugins from in-process into containers keeps no data. */
function switchOverLines(docs: string): string[] {
  return [
    `**Start over required.** Source Types now run as plugin containers, listed in \`plugins.yml\` (ADR-0001); the Sources of the in-process plugins do not carry over. See [Start over](${docs}#start-over).`,
  ];
}

/**
 * The "Upgrading" section of a GitHub Release, written from what changed since the release
 * before it (`previous`, or none for the first release). `docs` is the address of
 * `docs/upgrading.md` at the release, which the section links into.
 */
export function deriveUpgrading(previous: Snapshot | null, current: Snapshot, docs: string): string {
  const lines =
    previous === null
      ? ["This is the first release: there is nothing to upgrade from."]
      : [
          ...(previous.inProcessPlugins && !current.inProcessPlugins ? switchOverLines(docs) : dataLines(previous.migrations, current.migrations, docs)),
          ...postgresLines(previous.compose, current.compose, docs),
        ];
  return ["## Upgrading", "", ...lines.map((line) => `- ${line}`), ""].join("\n");
}
