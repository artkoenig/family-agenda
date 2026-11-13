# Writing a plugin with the plugin kit

A plugin is a container that answers the plugin contract over HTTP (ADR-0001). The contract is the OpenAPI document `packages/plugin-contract/openapi.json`; a plugin may be written in any language. For TypeScript, `packages/plugin-kit` is an optional helper:

- `@family-agenda/plugin-kit`: the types of a plugin (`PluginImplementation`, one function per endpoint) and `PluginError`, thrown to answer with a `definite` or `temporary` error.
- `@family-agenda/plugin-kit/server`: `servePlugin(plugin, { port })` serves it over HTTP; `createPluginHandler(plugin)` is the same as a `(Request) => Promise<Response>` function. Both validate every request and response against the contract: an invalid request is refused with a definite error, an invalid response becomes a temporary one. The description's `contractVersion` and `endpoints` are filled in.
- `@family-agenda/plugin-kit/testing`: the contract tests, without vitest. `contractProblems(target, options)` returns the problems found. `@family-agenda/plugin-kit/vitest`: `describePluginContract(() => target, options)` adds them to a vitest suite. A target is a plugin's URL, such as a container started for the test, or a handler, called in-process without Docker.

`tools/demo-source` is a plugin built with it (`src/plugin.ts`, `src/main.ts`, `Dockerfile`, `test/plugin.test.ts`).

## External ids of messages

A Source Record's `externalId` is what it is known by within its Source. For a message it means more: the core takes messages with the same `externalId` in Sources of one Source Type for Copies of one message (ADR-0005), reads only the first, and lets its Items concern everyone any Copy concerns. So give a message the same `externalId` in every Source of your Source Type that receives it, such as a mail's `Message-ID` in each mailbox of a mailing list, and never give it to another message. An id that only says where a message is, such as a position in a mailbox, has to differ per Source, for example by carrying the account. This does not apply to stated Source Records, such as calendar entries.

## Connections outside

A plugin's container reaches the internet only through its egress proxy. Since plugin contract 3.0, every call for a Source carries `egressProxy`, such as `http://ticket:<ticket>@plugin-imap-egress:3128`: make every connection of that call through it, with its credentials, for example `new ProxyAgent(context.egressProxy)` of `undici` as the `dispatcher` of `fetch`, which sends them as `Proxy-Authorization`. Use the URL of the call at hand, never one kept from an earlier call: its ticket is for that one Source and expires shortly after the call's timeout. The proxy refuses a connection without it, such as through `HTTPS_PROXY` of the environment, with `407`; answer that like any other failure to connect, as a temporary error. It lets the call through to the hosts declared in `plugins.yml` and the host fields of that Source only. The contract tests poll with `options.egressProxy`, by default a proxy that never resolves.

## Consuming it from another repository

Neither the kit nor the contract is published to a registry. Add both as git dependencies, pinned to a release tag, each from its directory of this repository (pnpm's `path:` selector):

```json
{
  "dependencies": {
    "@family-agenda/plugin-contract": "github:artkoenig/family-agenda#v0.2.0&path:/packages/plugin-contract",
    "@family-agenda/plugin-kit": "github:artkoenig/family-agenda#v0.2.0&path:/packages/plugin-kit",
    "tsx": "^4"
  },
  "devDependencies": {
    "vitest": "^5"
  }
}
```

Use the same tag for both: the kit is built against the contract of its release. The packages ship TypeScript sources, so run the plugin with `node --import tsx` (as the demo Source's image does) or bundle it. vitest is only needed for `@family-agenda/plugin-kit/vitest`.

```ts
// src/main.ts
import { servePlugin } from "@family-agenda/plugin-kit/server";
await servePlugin(myPlugin, { port: Number(process.env.PORT ?? 8080) });

// test/contract.test.ts
import { createPluginHandler } from "@family-agenda/plugin-kit/server";
import { describePluginContract } from "@family-agenda/plugin-kit/vitest";
describePluginContract(() => createPluginHandler(myPlugin), { config: { plain: {}, secrets: {} }, languages: ["de"] });
```

Raising the tag picks up a newer contract; the core loads a plugin whose contract version has its major and a minor no newer than its own.
