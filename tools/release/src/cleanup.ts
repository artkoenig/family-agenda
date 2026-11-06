/** A version of the container package in GHCR: a manifest, with the tags that point at it. */
export type PackageVersion = { id: number; digest: string; createdAt: Date; tags: string[] };

/** What a manifest refers to, by digest: the platform images of a manifest list, and an image's attestations. `null` where it could not be read. */
export type Children = Record<string, string[] | null>;

export type CleanupRules = {
  /** How many of the images tagged only `sha-<commit>` stay, the newest. */
  keepShaImages: number;
  /** How old an untagged version has to be to go, so that one that is just being pushed is left alone. */
  minimumAgeDays: number;
  /** A plan to delete more than this is a mistake: it throws instead. */
  maximumDeletions: number;
};

export type CleanupPlan = { delete: PackageVersion[]; keptTagged: number; keptUntagged: number };

const shaTag = /^sha-[0-9a-f]+$/;

/** An untagged version, one only tagged `sha-<commit>`, or anything else (`main`, `latest`, `0.3.1`, `0.3`, a tag nobody knows): which is never deleted. */
function kindOf(version: PackageVersion): "untagged" | "sha" | "kept" {
  if (version.tags.length === 0) return "untagged";
  return version.tags.every((tag) => shaTag.test(tag)) ? "sha" : "kept";
}

/** Every digest that the given manifests refer to, directly or through other manifests. */
function reachableFrom(roots: string[], children: Children): Set<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  for (let digest = pending.pop(); digest !== undefined; digest = pending.pop()) {
    const below = children[digest];
    if (below === undefined || below === null) {
      throw new Error(`The manifest ${digest} of an image that stays could not be read; nothing is deleted`);
    }
    for (const child of below) {
      if (!reached.has(child)) {
        reached.add(child);
        pending.push(child);
      }
    }
  }
  return reached;
}

const byNewest = (a: PackageVersion, b: PackageVersion) => b.createdAt.getTime() - a.createdAt.getTime();

/**
 * What to delete from the package. Tagged versions stay, except images tagged only `sha-<commit>`
 * beyond the newest few. An untagged version stays if an image that stays refers to it, through
 * any number of manifests, because GHCR lists the platform images and attestations of a multi-
 * platform image as untagged versions of their own; it goes when nothing refers to it and it is
 * old enough. The children of a `sha-` image that goes now are referenced by nothing that stays,
 * so they go in the same run.
 */
export function planCleanup(versions: PackageVersion[], children: Children, now: Date, rules: CleanupRules): CleanupPlan {
  const ofKind = (kind: ReturnType<typeof kindOf>) => versions.filter((version) => kindOf(version) === kind);
  const shaImages = ofKind("sha").sort(byNewest);
  const staying = [...ofKind("kept"), ...shaImages.slice(0, rules.keepShaImages)];
  const referenced = reachableFrom(staying.map((version) => version.digest), children);
  const oldest = now.getTime() - rules.minimumAgeDays * 24 * 60 * 60 * 1000;
  const untagged = ofKind("untagged");
  const unused = untagged.filter((version) => !referenced.has(version.digest) && version.createdAt.getTime() <= oldest);
  const plan = { delete: [...shaImages.slice(rules.keepShaImages), ...unused], keptTagged: staying.length, keptUntagged: untagged.length - unused.length };
  if (plan.delete.length > rules.maximumDeletions) {
    throw new Error(`The plan deletes ${plan.delete.length} versions, more than the ${rules.maximumDeletions} that a run may; look at it by hand`);
  }
  return plan;
}

/** A version as the GitHub API lists it: `name` is the digest of the manifest. */
type ApiVersion = { id: number; name: string; created_at: string; metadata?: { container?: { tags?: string[] } } };

/** The versions of a package from the response of `GET /users/{owner}/packages/container/{name}/versions`. */
export function versionsFromApi(listing: ApiVersion[]): PackageVersion[] {
  return listing.map((entry) => ({
    id: entry.id,
    digest: entry.name,
    createdAt: new Date(entry.created_at),
    tags: entry.metadata?.container?.tags ?? [],
  }));
}
