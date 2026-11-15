import { openAgendaAccess } from "@family-agenda/application";
import type { Application } from "../../src/composition-root";
import { createHttpApp, type HttpOptions } from "../../src/http/app";
import { bootForTest, type SecondFamily, type TestInstance, type TestOptions } from "./boot";

type RequestInit = { cookie?: string; headers?: Record<string, string> };

/** Requests to one `api` container of an Instance. */
export type HttpClient = {
  /** Posts a multipart form, as for a file upload. */
  request: (path: string, init: RequestInit & { body: FormData }) => Promise<Response>;
  get: (path: string, init?: RequestInit) => Promise<Response>;
  post: (path: string, form: Record<string, string>, init?: RequestInit) => Promise<Response>;
};

export type HttpTestInstance = TestInstance & HttpClient & {
  /** Boots a second `api` container against the same database, and drives its Hono app. */
  bootHttpApiContainer(): Promise<HttpClient>;
  /** Boots a second Family in the same process, with a database of its own, and drives its Hono app. */
  bootHttpSecondFamily(): Promise<HttpClient & SecondFamily>;
};

/** Boots an Instance and drives its Hono app with in-process requests. */
export async function bootHttpForTest(
  options: Partial<HttpOptions> = {},
  testOptions: TestOptions = {},
): Promise<HttpTestInstance> {
  const instance = await bootForTest(testOptions);
  const httpAppOf = (app: Application) => createHttpApp(app, { trustProxy: false, agendaAccess: openAgendaAccess, ...options });
  // The app of the Instance as it runs now, booted again after a restart.
  let booted = instance.app;
  let current = httpAppOf(booted);
  const http = {
    request: (path: string, init: Parameters<typeof current.request>[1]) => {
      if (instance.app !== booted) {
        booted = instance.app;
        current = httpAppOf(booted);
      }
      return current.request(path, init);
    },
  };
  // The same object, so that `app` stays the one running after a restart.
  return Object.assign(instance, clientOf(http), {
    bootHttpApiContainer: async () => {
      const other = httpAppOf(await instance.bootApiContainer());
      return clientOf({ request: (path, init) => other.request(path, init) });
    },
    bootHttpSecondFamily: async () => {
      const family = await instance.bootSecondFamily();
      const other = httpAppOf(family.app);
      return { ...family, ...clientOf({ request: (path, init) => other.request(path, init) }) };
    },
  });
}

export type HttpPrefixedTestInstance = HttpTestInstance & {
  /** Requests straight to the core, past the proxy, as the health check of the container makes them. */
  core: HttpClient;
};

/**
 * Boots an Instance served below `prefix` (such as `/agenda`), with `PUBLIC_URL` below it. Its
 * requests take the paths the browser uses, prefix included; like the proxy in front, the client
 * removes the prefix before the core sees them, and refuses a path outside it.
 */
export async function bootHttpForTestBelow(
  prefix: string,
  options: Partial<HttpOptions> = {},
  testOptions: TestOptions = {},
): Promise<HttpPrefixedTestInstance> {
  const instance = await bootHttpForTest({ publicUrl: `http://localhost${prefix}`, ...options }, testOptions);
  const core: HttpClient = { get: instance.get, post: instance.post, request: instance.request };
  const unprefixed = (path: string) => {
    if (!path.startsWith(`${prefix}/`)) throw new Error(`${path} lies outside the prefix ${prefix}`);
    return path.slice(prefix.length);
  };
  return Object.assign(instance, {
    core,
    get: (path: string, init?: RequestInit) => core.get(unprefixed(path), init),
    post: (path: string, form: Record<string, string>, init?: RequestInit) => core.post(unprefixed(path), form, init),
    request: (path: string, init: RequestInit & { body: FormData }) => core.request(unprefixed(path), init),
  });
}

function clientOf(http: { request: (path: string, init: { method?: string; body?: FormData | URLSearchParams; headers?: Record<string, string> }) => Response | Promise<Response> }): HttpClient {
  const headersFor = (init?: RequestInit) => ({
    ...(init?.cookie ? { cookie: init.cookie } : {}),
    ...init?.headers,
  });
  return {
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
