/** Where a file is kept in the BlobStore, outside Postgres. */
export type BlobRef = string & { readonly __brand: "BlobRef" };

/** The image formats a photo may have. */
export const photoTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

export type PhotoType = (typeof photoTypes)[number];

export type Photo = { blob: BlobRef; contentType: PhotoType };

export const maximumPhotoBytes = 5 * 1024 * 1024;

/** Each format's signature, as byte sequences at offsets that all have to match. */
const signatures: { type: PhotoType; parts: [at: number, bytes: number[]][] }[] = [
  { type: "image/jpeg", parts: [[0, [0xff, 0xd8, 0xff]]] },
  { type: "image/png", parts: [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]] },
  { type: "image/gif", parts: [[0, [0x47, 0x49, 0x46, 0x38]]] },
  { type: "image/webp", parts: [[0, [0x52, 0x49, 0x46, 0x46]], [8, [0x57, 0x45, 0x42, 0x50]]] },
];

/**
 * The image format a file starts with, or null if it is none that is shown as a photo.
 * Decided by the file's own bytes, never by the type a browser claims, so that no SVG or
 * HTML is ever served as a photo.
 */
export function photoTypeOf(file: Uint8Array): PhotoType | null {
  const match = signatures.find((signature) =>
    signature.parts.every(([at, bytes]) => bytes.every((byte, index) => file[at + index] === byte)),
  );
  return match?.type ?? null;
}
