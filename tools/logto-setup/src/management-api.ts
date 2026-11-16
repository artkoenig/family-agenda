/** The few calls the setup makes to Logto's Management API, each with a JSON body and answer. */
export interface ManagementApi {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
}

/** The API resource of Logto OSS, whose only tenant is `default`. */
export const managementApiResource = "https://default.logto.app/api";

/** `url` without trailing slashes, without a backtracking regular expression. */
export function withoutTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

/**
 * Signs in to Logto's Management API as a machine-to-machine app (client credentials, scope
 * `all`) and returns its calls. `endpoint` is where this process reaches Logto, such as
 * http://logto:3001 inside the Compose network.
 */
export async function connectManagementApi(endpoint: string, appId: string, appSecret: string, fetchFn: typeof fetch = fetch): Promise<ManagementApi> {
  const base = withoutTrailingSlash(endpoint);
  const tokenResponse = await fetchFn(`${base}/oidc/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials", resource: managementApiResource, scope: "all" }),
  });
  if (!tokenResponse.ok) throw new Error(`Logto refused the machine-to-machine app (${String(tokenResponse.status)}): ${await tokenResponse.text()}`);
  const { access_token: token } = (await tokenResponse.json()) as { access_token: string };

  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetchFn(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path} failed (${String(response.status)}): ${await response.text()}`);
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    patch: (path, body) => call("PATCH", path, body),
    put: (path, body) => call("PUT", path, body),
  };
}
