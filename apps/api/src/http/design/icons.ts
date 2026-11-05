import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** The icons of an Agenda on a home screen, by file name. */
export const icons: Record<string, Buffer<ArrayBuffer>> = Object.fromEntries(
  ["icon-192.png", "icon-512.png", "apple-touch-icon.png"].map(
    (file) => [file, readFileSync(new URL(`./icons/${file}`, import.meta.url))] as const,
  ),
);

/** An icon's address with a version of its content, so that a new icon replaces one a phone has cached. */
export const iconUrl = (file: string): string => {
  const version = createHash("sha256").update(icons[file] ?? "").digest("hex").slice(0, 8);
  return `/static/icons/${file}?v=${version}`;
};
