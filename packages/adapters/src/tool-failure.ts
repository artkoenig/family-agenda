/** What a failed tool said, without the command line that names the temporary file. */
export function reason(error: unknown): string {
  const failed = error as { stderr?: unknown; killed?: boolean; code?: unknown; message?: string };
  if (failed.killed) return "Converting it took too long.";
  if (failed.code === "ENOENT") return `A tool to convert it is not installed: ${failed.message ?? ""}`.trim();
  const stderr = typeof failed.stderr === "string" ? failed.stderr.trim().split("\n")[0] : "";
  return stderr || "It could not be converted.";
}
