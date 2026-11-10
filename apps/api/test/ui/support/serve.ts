import { serve as serveNode } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { tsImport } from "tsx/esm/api";
import { fakeApplication, type Fakes } from "./fake-application";
import type { httpAppFor as HttpAppFor } from "./http-app";

export type Served = { url: string; /** The calls its pages made that the fakes did not give, such as `sources.edit`. */
  unfaked: string[]; close(): Promise<void> };

/**
 * The app is loaded through tsx, as it runs in production: Playwright's own transform compiles
 * JSX for React, not for Hono's `jsxImportSource`, and so would render `[object Object]`. The
 * Playwright config leaves the app's sources to tsx for that reason.
 */
const loading = tsImport("./http-app.ts", import.meta.url) as Promise<{ httpAppFor: typeof HttpAppFor }>;

/** Starts the real HTTP app on a free port, against an Application that answers only `fakes`. */
export async function serve(fakes: Fakes): Promise<Served> {
  const { application, unfaked } = fakeApplication(fakes);
  const app = (await loading).httpAppFor(application);
  const server = await new Promise<ReturnType<typeof serveNode>>((resolve) => {
    const started = serveNode({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => {
      resolve(started);
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    unfaked,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
