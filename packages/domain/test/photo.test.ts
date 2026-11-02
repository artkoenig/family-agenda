import { describe, it, expect } from "vitest";
import { photoTypeOf, maximumPhotoBytes } from "../src/photo";

describe("photoTypeOf", () => {
  it("detects JPEG", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    expect(photoTypeOf(bytes)).toBe("image/jpeg");
  });

  it("detects PNG", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(photoTypeOf(bytes)).toBe("image/png");
  });

  it("detects GIF", () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
    expect(photoTypeOf(bytes)).toBe("image/gif");
  });

  it("detects WebP (RIFF header + WEBP at offset 8)", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x24, 0x00, 0x00, 0x00, // size
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      0x56, 0x50, 0x38, 0x20, // "VP8 "
    ]);
    expect(photoTypeOf(bytes)).toBe("image/webp");
  });

  it("returns null for RIFF without WEBP marker", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x24, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20, // "AVI " (not WEBP)
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(photoTypeOf(bytes)).toBe(null);
  });

  it("returns null for non-image bytes", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
    expect(photoTypeOf(bytes)).toBe(null);
  });

  it("returns null for a too-short buffer (less than JPEG signature)", () => {
    const bytes = new Uint8Array([0xff, 0xd8]);
    expect(photoTypeOf(bytes)).toBe(null);
  });

  it("returns null for empty buffer", () => {
    const bytes = new Uint8Array([]);
    expect(photoTypeOf(bytes)).toBe(null);
  });

  it("returns null for WebP with RIFF but wrong offset 8 bytes", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x24, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x51, // "WEBQ" (not WEBP)
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(photoTypeOf(bytes)).toBe(null);
  });

  it("returns null for a buffer that is long enough for RIFF but not for WEBP check", () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);
    expect(photoTypeOf(bytes)).toBe(null);
  });

  it("returns null when offset 8 is WEBP but offset 0 is not RIFF", () => {
    const bytes = new Uint8Array([
      0x58, 0x58, 0x58, 0x58,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(photoTypeOf(bytes)).toBe(null);
  });
});

describe("maximumPhotoBytes", () => {
  it("is 5 MiB", () => {
    expect(maximumPhotoBytes).toBe(5 * 1024 * 1024);
  });
});
