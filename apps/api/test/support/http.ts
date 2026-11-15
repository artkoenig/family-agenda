import { openAgendaAccess } from "@family-agenda/application";
import { createHttpApp, type HttpOptions } from "../../src/http/app";
import { bootForTest, type TestInstance, type TestOptions } from "./boot";

type RequestInit = { cookie?: string; headers?: Record<string, string> };

/** Requests to one `api` container of an Instance. */
export type HttpClient = {
  /** Posts a multipart form, as for a file upload. */
  request(path: string, init: RequestInit & { body: FormData }): Promise<Response>;
  get(path: string, init?: RequestInit): Promise<Response>;
  post(
    path: string,
    form: Record<string, string>,
    init?: RequestInit,
  ): Promise<Response>;
};

export type HttpTestInstance = TestInstance & HttpClient & {
  /** Boots a second `api` container against the same database, and drives its Hono app. */
  bootHttpApiContainer(): Promise<HttpClient>;
};

/** Boots an Instance and drives its Hono app with in-process requests. */
export async function bootHttpForTest(
  options: Partial<HttpOptions> = {},
  testOptions: TestOptions = {},
): Promise<HttpTestInstance> {
  const instance = await bootForTest(testOptions);
  // The app of the Instance as it runs now, booted again after a restart.
  let booted = instance.app;
  let current = createHttpApp(booted, { trustProxy: false, agendaAccess: openAgendaAccess, ...options });
  const http = {
    request: (path: string, init: Parameters<typeof current.request>[1]) => {
      if (instance.app !== booted) {
        booted = instance.app;
        current = createHttpApp(booted, { trustProxy: false, agendaAccess: openAgendaAccess, ...options });
      }
      return current.request(path, init);
    },
  };
  // The same object, so that `app` stays the one running after a restart.
  return Object.assign(instance, clientOf(http), {
    bootHttpApiContainer: async () => {
      const other = createHttpApp(await instance.bootApiContainer(), { trustProxy: false, agendaAccess: openAgendaAccess, ...options });
      return clientOf({ request: (path, init) => other.request(path, init) });
    },
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
