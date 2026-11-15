/**
 * Where an address leaves the core, named once for the lint rule that keeps literal root paths out
 * of them (`eslint.config.js`) and the test that crawls an Instance below a path prefix. Plain
 * JavaScript, so that `eslint.config.js` imports it on every Node the repo supports; its types are
 * in `addresses.d.ts`.
 */

/** The attributes of the markup that name an address. */
export const addressAttributes = Object.freeze([
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
]);

/** The response headers that send the browser to an address, in lower case. */
export const redirectHeaders = Object.freeze(["location", "hx-redirect", "hx-location", "hx-push-url", "hx-replace-url"]);
