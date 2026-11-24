import type { ExportEntry } from "@family-agenda/application";
import { makeZip } from "client-zip";

/**
 * The Export's files as one ZIP, made as it is read: each file is read only when the ZIP gets to
 * it, so memory stays bounded however large the files are. The files are stored, not compressed.
 */
export function exportZip(entries: AsyncIterable<ExportEntry>): ReadableStream<Uint8Array> {
  // client-zip rejects a cancel, such as when the browser stops the download, with its reason;
  // piped on, the cancel ends the files being read and settles quietly.
  return makeZip(filesOf(entries)).pipeThrough(new TransformStream<Uint8Array, Uint8Array>());
}

async function* filesOf(entries: AsyncIterable<ExportEntry>) {
  for await (const { path, contents } of entries) yield { name: path, input: contents };
}
