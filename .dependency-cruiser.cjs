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
      to: { path: "^(apps/|packages/(contracts|source-[^/]+)/)" },
    },
    {
      name: "contracts-import-only-zod",
      severity: "error",
      from: { path: "^packages/contracts/" },
      to: { pathNot: ["^packages/contracts/", "/node_modules/zod/"] },
    },
    {
      name: "plugin-contract-imports-only-zod",
      comment: "The plugin contract is what plugins in other repositories build against (ADR-0001).",
      severity: "error",
      from: { path: "^packages/plugin-contract/" },
      to: { pathNot: ["^packages/plugin-contract/", "/node_modules/zod/"], dependencyTypesNot: ["core"] },
    },
    {
      name: "plugin-kit-imports-only-the-plugin-contract",
      comment: "Plugin repositories consume the kit as a git dependency, beside the plugin contract (ADR-0001).",
      severity: "error",
      from: { path: "^packages/plugin-kit/" },
      to: { pathNot: ["^packages/(plugin-kit|plugin-contract)/", "/node_modules/(zod|vitest)/"], dependencyTypesNot: ["core"] },
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
