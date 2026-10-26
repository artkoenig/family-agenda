import { randomUUID } from "node:crypto";
import {
  initialOf,
  maximumPhotoBytes,
  parseName,
  photoTypeOf,
  type FamilyMember,
  type FamilyMemberId,
  type Photo,
  type PhotoType,
} from "@family-butler/domain";
import type { BlobStore, Clock, FamilyMemberRepository, FamilyRepository } from "./ports";

export type FamilyMembersDeps = {
  clock: Clock;
  families: FamilyRepository;
  members: FamilyMemberRepository;
  blobs: BlobStore;
};

export type FamilyMemberSummary = {
  id: FamilyMemberId;
  name: string;
  /** What the avatar shows without a photo. */
  initial: string;
  hasPhoto: boolean;
};

export type FamilyMemberProblem = "invalid-name" | "invalid-photo" | "photo-too-large";

export type EditResult =
  | { ok: true }
  | { ok: false; problem: FamilyMemberProblem | "unknown-member" };

export function createFamilyMemberAccess(deps: FamilyMembersDeps) {
  const { clock, families, members, blobs } = deps;

  /** Checks a new photo and stores it. */
  async function storePhoto(
    file: Uint8Array,
  ): Promise<{ ok: true; photo: Photo } | { ok: false; problem: FamilyMemberProblem }> {
    if (file.length > maximumPhotoBytes) return { ok: false, problem: "photo-too-large" };
    const contentType = photoTypeOf(file);
    if (!contentType) return { ok: false, problem: "invalid-photo" };
    return { ok: true, photo: { blob: await blobs.put(file), contentType } };
  }

  return {
    async list(): Promise<FamilyMemberSummary[]> {
      const all = await members.list(await families.theFamily());
      return all.map(summariseFamilyMember);
    },

    /** `photo` is the uploaded file, if any. */
    async add(input: {
      name: string;
      photo?: Uint8Array;
    }): Promise<{ ok: true; id: FamilyMemberId } | { ok: false; problem: FamilyMemberProblem }> {
      const name = parseName(input.name);
      if (!name) return { ok: false, problem: "invalid-name" };
      let photo: Photo | null = null;
      if (input.photo) {
        const stored = await storePhoto(input.photo);
        if (!stored.ok) return stored;
        photo = stored.photo;
      }
      const id = randomUUID() as FamilyMemberId;
      await members.add({ id, familyId: await families.theFamily(), name, photo, createdAt: clock.now() });
      return { ok: true, id };
    },

    /** `photo` replaces the photo, null removes it, and leaving it out keeps it. */
    async edit(
      id: FamilyMemberId,
      input: { name: string; photo?: Uint8Array | null },
    ): Promise<EditResult> {
      const member = await members.findById(id);
      if (!member) return { ok: false, problem: "unknown-member" };
      const name = parseName(input.name);
      if (!name) return { ok: false, problem: "invalid-name" };
      let photo = member.photo;
      if (input.photo === null) photo = null;
      else if (input.photo) {
        const stored = await storePhoto(input.photo);
        if (!stored.ok) return stored;
        photo = stored.photo;
      }
      await members.update({ ...member, name, photo });
      if (member.photo && member.photo.blob !== photo?.blob) await blobs.remove(member.photo.blob);
      return { ok: true };
    },

    async remove(id: FamilyMemberId): Promise<void> {
      const member = await members.findById(id);
      if (!member) return;
      await members.remove(id);
      if (member.photo) await blobs.remove(member.photo.blob);
    },

    /** The Family Member's photo, or null if they have none. */
    async photo(id: FamilyMemberId): Promise<{ bytes: Uint8Array; contentType: PhotoType } | null> {
      const member = await members.findById(id);
      if (!member?.photo) return null;
      const bytes = await blobs.get(member.photo.blob);
      return bytes && { bytes, contentType: member.photo.contentType };
    },
  };
}

export type FamilyMemberAccess = ReturnType<typeof createFamilyMemberAccess>;

export function summariseFamilyMember(member: FamilyMember): FamilyMemberSummary {
  return {
    id: member.id,
    name: member.name,
    initial: initialOf(member.name),
    hasPhoto: member.photo !== null,
  };
}
