import { openViewAccess } from "@family-butler/application";
import { createHttpApp, type HttpOptions } from "../../src/http/app";
import { bootForTest, type TestInstance, type TestOptions } from "./boot";

type RequestInit = { cookie?: string; headers?: Record<string, string> };

export type HttpTestInstance = TestInstance & {
  /** Posts a multipart form, as for a file upload. */
  request(path: string, init: RequestInit & { body: FormData }): Promise<Response>;
  get(path: string, init?: RequestInit): Promise<Response>;
  post(
    path: string,
    form: Record<string, string>,
    init?: RequestInit,
  ): Promise<Response>;
};

/** Boots an Instance and drives its Hono app with in-process requests. */
export async function bootHttpForTest(
  options: Partial<HttpOptions> = {},
  testOptions: TestOptions = {},
): Promise<HttpTestInstance> {
  const instance = await bootForTest(testOptions);
  const http = createHttpApp(instance.app, { trustProxy: false, viewAccess: openViewAccess, ...options });
  const headersFor = (init?: RequestInit) => ({
    ...(init?.cookie ? { cookie: init.cookie } : {}),
    ...init?.headers,
  });
  return {
    ...instance,
    get: async (path, init) => http.request(path, { headers: headersFor(init) }),
    request: async (path, init) =>
      http.request(path, {
        method: "POST",
        body: init.body,
        headers: { origin: "http://localhost", ...headersFor(init) },
      }),
    post: async (path, form, init) =>
      http.request(path, {
        method: "POST",
        body: new URLSearchParams(form),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost",
          ...headersFor(init),
        },
      }),
  };
}

/** The `name=value` pair of the session cookie a response sets, to send back. */
export function sessionCookieOf(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const pair = setCookie?.split(";")[0];
  if (!pair) throw new Error("response sets no cookie");
  return pair;
}
