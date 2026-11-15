import { createContext, useContext } from "hono/jsx";

/**
 * The path prefix the Instance is served below, such as `/agenda`: the path of `PUBLIC_URL`, empty
 * without one. The proxy in front removes it before a request reaches the core, so the routes do
 * not know it; every address the core emits must put it back.
 */
export const PathPrefixContext = createContext("");

/** The path prefix of a public address: its path without the trailing slash, empty for none. */
export function pathPrefixOf(publicUrl: string | undefined): string {
  return publicUrl === undefined ? "" : new URL(publicUrl).pathname.replace(/\/+$/, ""); // eslint-disable-line sonarjs/super-linear-regex -- single-char quantifier anchored at end is O(n)
}

/**
 * The address of `path` (from the root of the Instance, such as `/admin`) below the path prefix:
 * every link, form, redirect and cookie path is built with it. A page takes the prefix from
 * `PathPrefixContext`; a route passes it.
 */
export function href(path: `/${string}`, prefix: string = useContext(PathPrefixContext)): string {
  // The root itself is the prefix, so that a cookie for it covers the prefix exactly.
  return path === "/" && prefix !== "" ? prefix : prefix + path;
}
