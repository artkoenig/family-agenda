/**
 * Where an address leaves the core, named once for the lint rule that keeps literal root paths out
 * of them (`eslint.config.js`) and the test that crawls an Instance below a path prefix. Plain data
 * only: `eslint.config.js` imports this file as it is.
 */

/** The attributes of the markup that name an address. */
export const addressAttributes = [
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "hx-get",
  "hx-post",
  "hx-put",
  "hx-patch",
  "hx-delete",
  "hx-push-url",
  "hx-replace-url",
] as const;

/** The response headers that send the browser to an address, in lower case. */
export const redirectHeaders = ["location", "hx-redirect", "hx-location", "hx-push-url", "hx-replace-url"] as const;
