import { createHttpApp, type HttpOptions } from "../../src/http/app";
import { bootForTest, type TestInstance } from "./boot";

export type HttpTestInstance = TestInstance & {
  get(path: string, init?: { cookie?: string; headers?: Record<string, string> }): Promise<Response>;
  post(
    path: string,
    form: Record<string, string>,
    init?: { cookie?: string; headers?: Record<string, string> },
  ): Promise<Response>;
};

/** Boots an Instance and drives its Hono app with in-process requests. */
export async function bootHttpForTest(options: Partial<HttpOptions> = {}): Promise<HttpTestInstance> {
  const instance = await bootForTest();
  const http = createHttpApp(instance.app, { trustProxy: false, ...options });
  const headersFor = (init?: { cookie?: string; headers?: Record<string, string> }) => ({
    ...(init?.cookie ? { cookie: init.cookie } : {}),
    ...init?.headers,
  });
  return {
    ...instance,
    get: async (path, init) => http.request(path, { headers: headersFor(init) }),
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
