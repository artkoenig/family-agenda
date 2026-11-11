import { randomUUID } from "node:crypto";
import {
  initialOf,
  maximumPhotoBytes,
  nextColour,
  parseAvatar,
  parseColour,
  parseName,
  photoTypeOf,
  type FamilyMember,
  type FamilyMemberId,
  type MemberAvatar,
  type MemberColour,
  type Photo,
  type PhotoType,
} from "@family-agenda/domain";
import type { BlobStore, Clock, FamilyMemberRepository, SoleAssignment } from "./ports";

export type FamilyMembersDeps = {
  clock: Clock;
  members: FamilyMemberRepository;
  blobs: BlobStore;
};

export type FamilyMemberSummary = {
  id: FamilyMemberId;
  name: string;
  /** What the avatar shows without a photo. */
  initial: string;
  /** The colour behind the initial. */
  colour: MemberColour;
  /** The animal on the colour instead of the initial, if any. */
  avatar: MemberAvatar | null;
  hasPhoto: boolean;
};

export type FamilyMemberProblem = "invalid-name" | "invalid-colour" | "invalid-avatar" | "invalid-photo" | "photo-too-large";

/** Removing is refused while a Source Attribute is assigned to the Family Member alone; `blocking` names them. */
export type RemoveResult = { ok: true } | { ok: false; problem: "sole-assignee"; blocking: SoleAssignment[] };

export type EditResult =
  | { ok: true }
  | { ok: false; problem: FamilyMemberProblem | "unknown-member" };

export function createFamilyMemberAccess(deps: FamilyMembersDeps) {
  const { clock, members, blobs } = deps;

  /** Checks a new photo and stores it. */
  async function storePhoto(
    file: Uint8Array,
  ): Promise<{ ok: true; photo: Photo } | { ok: false; problem: FamilyMemberProblem }> {
    if (file.length > maximumPhotoBytes) return { ok: false, problem: "photo-too-large" };
    const contentType = photoTypeOf(file);
    if (!contentType) return { ok: false, problem: "invalid-photo" };
    return { ok: true, photo: { blob: await blobs.put(file), contentType } };
  }

  /** Resolves the photo: null removes it, a file replaces it, and leaving it out keeps it. */
  async function resolvePhoto(
    current: Photo | null,
    input: Uint8Array | null | undefined,
  ): Promise<{ ok: true; photo: Photo | null } | { ok: false; problem: FamilyMemberProblem }> {
    if (input === null) return { ok: true, photo: null };
    if (!input) return { ok: true, photo: current };
    const stored = await storePhoto(input);
    if (!stored.ok) return { ok: false, problem: stored.problem };
    return { ok: true, photo: stored.photo };
  }

  /** The colour and animal of a new Family Member, as chosen or else as given. */
  async function chooseLooks(input: {
    colour?: string;
    avatar?: string;
  }): Promise<{ ok: true; looks: { colour: MemberColour; avatar: MemberAvatar | null } } | { ok: false; problem: FamilyMemberProblem }> {
    const colour =
      input.colour === undefined
        ? nextColour((await members.list()).map((other) => other.colour))
        : parseColour(input.colour);
    if (!colour) return { ok: false, problem: "invalid-colour" };
    const avatar = parseAvatar(input.avatar ?? "");
    if (!avatar.ok) return { ok: false, problem: "invalid-avatar" };
    return { ok: true, looks: { colour, avatar: avatar.avatar } };
  }

  return {
    async list(): Promise<FamilyMemberSummary[]> {
      const all = await members.list();
      return all.map(summariseFamilyMember);
    },

    /**
     * `photo` is the uploaded file, if any. Leaving out `colour` gives them the colour the fewest others
     * have; leaving out `avatar` gives them none.
     */
    async add(input: {
      name: string;
      colour?: string;
      avatar?: string;
      photo?: Uint8Array;
    }): Promise<{ ok: true; id: FamilyMemberId } | { ok: false; problem: FamilyMemberProblem }> {
      const name = parseName(input.name);
      if (!name) return { ok: false, problem: "invalid-name" };
      const looks = await chooseLooks(input);
      if (!looks.ok) return looks;
      let photo: Photo | null = null;
      if (input.photo) {
        const stored = await storePhoto(input.photo);
        if (!stored.ok) return stored;
        photo = stored.photo;
      }
      const id = randomUUID() as FamilyMemberId;
      await members.add({ id, name, photo, ...looks.looks, createdAt: clock.now() });
      return { ok: true, id };
    },

    /** `photo` replaces the photo, null removes it, and leaving it out keeps it; so does leaving out `colour` or `avatar`. */
    async edit(
      id: FamilyMemberId,
      input: { name: string; colour?: string; avatar?: string; photo?: Uint8Array | null },
    ): Promise<EditResult> {
      const member = await members.findById(id);
      if (!member) return { ok: false, problem: "unknown-member" };
      const name = parseName(input.name);
      if (!name) return { ok: false, problem: "invalid-name" };
      const looks = changeLooks(member, input);
      if (!looks.ok) return looks;
      const resolved = await resolvePhoto(member.photo, input.photo);
      if (!resolved.ok) return resolved;
      const photo = resolved.photo;
      await members.update({ ...member, name, ...looks.looks, photo });
      if (member.photo && member.photo.blob !== photo?.blob) await blobs.remove(member.photo.blob);
      return { ok: true };
    },

    /**
     * Removes the Family Member, also from the Agendas they are a member of: those with no one else
     * are removed with them, so that none widens to the whole Family.
     */
    async remove(id: FamilyMemberId): Promise<RemoveResult> {
      const member = await members.findById(id);
      if (!member) return { ok: true };
      const removed = await members.remove(id);
      if (!removed.removed) return { ok: false, problem: "sole-assignee", blocking: removed.blocking };
      if (member.photo) await blobs.remove(member.photo.blob);
      return { ok: true };
    },

    /** The Family Member's photo, or null if they have none. */
    async photo(id: FamilyMemberId): Promise<{
      bytes: Uint8Array<ArrayBuffer>;
      contentType: PhotoType;
    } | null> {
      const member = await members.findById(id);
      if (!member?.photo) return null;
      const bytes = await blobs.get(member.photo.blob);
      return bytes && { bytes, contentType: member.photo.contentType };
    },
  };
}

export type FamilyMemberAccess = ReturnType<typeof createFamilyMemberAccess>;

type Looks = { colour: MemberColour; avatar: MemberAvatar | null };

/** The colour and animal after a change; leaving one out keeps it. */
function changeLooks(
  member: FamilyMember,
  input: { colour?: string; avatar?: string },
): { ok: true; looks: Looks } | { ok: false; problem: FamilyMemberProblem } {
  const colour = resolveColour(member.colour, input.colour);
  if (!colour) return { ok: false, problem: "invalid-colour" };
  const avatar = input.avatar === undefined ? { ok: true as const, avatar: member.avatar } : parseAvatar(input.avatar);
  if (!avatar.ok) return { ok: false, problem: "invalid-avatar" };
  return { ok: true, looks: { colour, avatar: avatar.avatar } };
}

/** Leaving the colour out keeps it; null if it is none of the colours. */
function resolveColour(current: MemberColour, input: string | undefined): MemberColour | null {
  return input === undefined ? current : parseColour(input);
}

export function summariseFamilyMember(member: FamilyMember): FamilyMemberSummary {
  return {
    id: member.id,
    name: member.name,
    initial: initialOf(member.name),
    colour: member.colour,
    avatar: member.avatar,
    hasPhoto: member.photo !== null,
  };
}
