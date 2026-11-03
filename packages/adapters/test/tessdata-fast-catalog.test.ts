import { afterEach, describe, expect, it, vi } from "vitest";
import { tessdataFastCatalog } from "../src";
import type { OcrLanguage } from "@family-agenda/domain";

describe("tessdataFastCatalog's download", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const okResponse = (body: Uint8Array, contentLength?: string) =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(contentLength !== undefined ? { "content-length": contentLength } : {}),
      arrayBuffer: () => Promise.resolve(body.buffer as ArrayBuffer),
    }) as Response;

  it("returns the bytes of a model that fits", async () => {
    const bytes = new TextEncoder().encode("model data");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(bytes, String(bytes.byteLength)));

    const catalog = tessdataFastCatalog({ timeoutMs: 1000 });
    const result = await catalog.download("eng" as OcrLanguage);

    expect(result).toEqual(bytes);
    const [url] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(url).toContain("tessdata_fast");
    expect(url).toContain("eng.traineddata");
  });

  it("throws when GitHub answers with an error status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as Response);

    const catalog = tessdataFastCatalog({ timeoutMs: 1000 });
    await expect(catalog.download("eng" as OcrLanguage)).rejects.toThrow("GitHub answered 404 Not Found.");
  });

  it("throws when the content-length header exceeds the limit", async () => {
    const huge = "70000000"; // > 64 MB
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(new Uint8Array(0), huge));

    const catalog = tessdataFastCatalog({ timeoutMs: 1000 });
    await expect(catalog.download("eng" as OcrLanguage)).rejects.toThrow("The file is too large for a model.");
  });

  it("throws when the actual bytes exceed the limit", async () => {
    // A body larger than 64 MB would be impractical to allocate; instead, mock a response
    // whose content-length is small but whose arrayBuffer returns a larger buffer.
    const smallHeader = "10";
    const largeBody = new Uint8Array(65 * 1024 * 1024 + 1);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(largeBody, smallHeader));

    const catalog = tessdataFastCatalog({ timeoutMs: 1000 });
    await expect(catalog.download("eng" as OcrLanguage)).rejects.toThrow("The file is too large for a model.");
  });

  it("passes a timeout to fetch", async () => {
    const bytes = new TextEncoder().encode("x");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(bytes, "1"));

    const catalog = tessdataFastCatalog({ timeoutMs: 42 });
    await catalog.download("eng" as OcrLanguage);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
