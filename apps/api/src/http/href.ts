import { createContext, useContext } from "hono/jsx";

/**
 * The path prefix the Instance is served below, such as `/agenda`: the path of `PUBLIC_URL`, empty
 * without one. The proxy in front removes it before a request reaches the core, so the routes do
 * not know it; every address the core emits must put it back. A page reads it with `usePathPrefix`.
 */
export const PathPrefixContext = createContext("");

/** The path prefix of the page being rendered. */
export function usePathPrefix(): string {
  return useContext(PathPrefixContext);
}

/** The path prefix of a public address, which comes without a trailing slash (`readConfig`): its path, empty for none. */
export function pathPrefixOf(publicUrl: string | undefined): string {
  const path = publicUrl === undefined ? "/" : new URL(publicUrl).pathname;
  return path === "/" ? "" : path;
}

/**
 * The address of `path` (from the root of the Instance, such as `/admin`) below the path prefix:
 * every link, form, redirect and cookie path is built with it. A route passes its prefix; a page
 * passes `usePathPrefix()`.
 */
export function href(prefix: string, path: `/${string}`): string {
  // The root itself is the prefix, so that a cookie for it covers the prefix exactly.
  return path === "/" && prefix !== "" ? prefix : prefix + path;
}
