import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { memberAvatars, type MemberAvatar } from "@family-agenda/domain";

// The animals come from Fluent Emoji (flat), MIT licensed by Microsoft, as Iconify packages them. The
// Instance serves them itself, as it runs offline.

type IconSet = {
  width?: number;
  height?: number;
  icons: Record<string, { body: string; width?: number; height?: number }>;
};

const iconSet = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve("@iconify-json/fluent-emoji-flat/icons.json"), "utf8"),
) as IconSet;

/** Each animal as a standalone SVG file; starting fails should the package lack one. */
export const avatarImages: Record<string, Uint8Array<ArrayBuffer>> = Object.fromEntries(
  memberAvatars.map((avatar) => {
    const icon = iconSet.icons[avatar];
    if (!icon) throw new Error(`Fluent Emoji has no animal "${avatar}"`);
    const width = icon.width ?? iconSet.width ?? 32;
    const height = icon.height ?? iconSet.height ?? 32;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${icon.body}</svg>`;
    return [`${avatar}.svg`, new TextEncoder().encode(svg)];
  }),
);

export function avatarUrl(avatar: MemberAvatar): string {
  return `/static/avatars/${avatar}.svg`;
}

/**
 * The rules that show the chosen animal in the preview of a Family Member's dialog, one per animal, as
 * a stylesheet cannot name an image after the value of the radio button that is checked.
 */
export const avatarStylesheet = new TextEncoder().encode(
  memberAvatars
    .map(
      (avatar) =>
        `.fam-looks:has(input[name="avatar"][value="${avatar}"]:checked) .fam-looks__preview { background-image: url(${avatarUrl(avatar)}); }`,
    )
    .join("\n") + "\n",
);
