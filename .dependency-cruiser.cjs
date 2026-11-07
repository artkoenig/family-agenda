/**
 * Package boundaries of the Clean Architecture (ADR-0002, ADR-0010).
 * Workspace packages resolve to their real paths, so rules match on `packages/<name>/`; an
 * import of a package that is not declared as a dependency stays a bare `@family-agenda/<name>`.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "domain-imports-nothing",
      comment: "The domain is plain TypeScript: no npm packages, no Node.js modules, no other packages.",
      severity: "error",
      from: { path: "^packages/domain/src/" },
      to: { pathNot: "^packages/domain/" },
    },
    {
      name: "application-imports-only-domain",
      comment: "Use cases and ports depend on the domain and Node.js built-ins only.",
      severity: "error",
      from: { path: "^packages/application/" },
      to: { pathNot: "^packages/(application|domain)/", dependencyTypesNot: ["core"] },
    },
    {
      name: "adapters-implement-application-ports",
      comment: "Adapters know the domain and application, never the apps, contracts or plugins.",
      severity: "error",
      from: { path: "^packages/adapters/" },
      to: { path: "^(apps/|packages/(contracts|composition|source-[^/]+)/)" },
    },
    {
      name: "composition-wires-adapters-to-use-cases",
      comment: "The Composition Root is the one place that knows both use cases and adapters; only processes and tools build on it, never another package, and it never imports an app.",
      severity: "error",
      from: { path: "^packages/(?!composition/)" },
      to: { path: "^packages/composition/" },
    },
    {
      name: "contracts-import-only-zod",
      severity: "error",
      from: { path: "^packages/contracts/" },
      to: { pathNot: ["^packages/contracts/", "/node_modules/zod/"] },
    },
    {
      name: "source-sdk-imports-no-family-agenda-package",
      severity: "error",
      from: { path: "^packages/source-sdk/" },
      to: { path: "^(apps/|packages/(?!source-sdk/)|@family-agenda/(?!source-sdk$))" },
    },
    {
      name: "source-plugins-import-only-source-sdk",
      comment: "The SDK is the only Family Agenda package a plugin may import (ADR-0010).",
      severity: "error",
      from: { path: "^packages/(source-(?!sdk/)[^/]+)/" },
      to: {
        path: "^(apps/|packages/|@family-agenda/(?!source-sdk$))",
        pathNot: "^packages/($1|source-sdk)/",
      },
    },
    {
      name: "packages-do-not-import-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "packages-only-through-exports",
      comment: "A package is imported by its name, so only what its `exports` name is reachable; no relative path into another package or app.",
      severity: "error",
      from: { path: "^(packages|apps)/([^/]+)/" },
      to: { path: "^(packages|apps)/", pathNot: "^$1/$2/", dependencyTypes: ["local"] },
    },
    {
      name: "http-imports-only-application-and-contracts",
      comment: "The HTTP app knows the use cases and the wire contracts, never adapters, the Composition Root or plugins.",
      severity: "error",
      from: { path: "^packages/http/src/" },
      to: { path: "^(apps/|packages/(?!(http|application|contracts|domain)/))" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)node_modules/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".d.ts"],
    },
  },
};
