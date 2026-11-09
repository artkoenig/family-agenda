import type { SourceTypeId } from "@family-agenda/domain";

/** A Source Type whose plugin runs in a container of its own, at `url` (ADR-0001). */
export type PluginBinding = { sourceTypeId: SourceTypeId; url: string };

const sourceTypeIdPattern = /^[a-z][a-z0-9-]*$/;

/**
 * The bindings of `PLUGIN_URLS`, such as `demo=http://demo:8080,ics=http://ics:8080`: each Source
 * Type id with the base URL of its plugin container. Empty for none.
 */
export function parsePluginUrls(text: string | undefined): PluginBinding[] {
  const bindings: PluginBinding[] = [];
  for (const entry of (text ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    const at = entry.indexOf("=");
    const sourceTypeId = entry.slice(0, Math.max(at, 0)).trim();
    const url = entry.slice(at + 1).trim();
    if (!sourceTypeIdPattern.test(sourceTypeId) || !isHttpUrl(url)) {
      throw new Error(`PLUGIN_URLS takes Source Type ids with http or https addresses, such as demo=http://demo:8080; "${entry}" is none`);
    }
    if (bindings.some((binding) => binding.sourceTypeId === sourceTypeId)) throw new Error(`PLUGIN_URLS binds "${sourceTypeId}" twice`);
    bindings.push({ sourceTypeId: sourceTypeId as SourceTypeId, url: withoutTrailingSlashes(url) });
  }
  return bindings;
}

function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (url[end - 1] === "/") end--;
  return url.slice(0, end);
}

function isHttpUrl(url: string): boolean {
  return URL.canParse(url) && /^https?:$/.test(new URL(url).protocol);
}
