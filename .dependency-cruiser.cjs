/**
 * Package boundaries of the Clean Architecture (ADR-0001).
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
      comment: "Adapters know the domain and application, never the apps or contracts.",
      severity: "error",
      from: { path: "^packages/adapters/" },
      to: { path: "^(apps/|packages/contracts/)" },
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
      name: "packages-do-not-import-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "ui-tests-use-no-database",
      comment: "Browser UI tests run against a fake Application, without a database (ADR-0007); the composition root is theirs for its types only.",
      severity: "error",
      from: { path: "^apps/api/test/ui/" },
      to: { path: ["^apps/api/test/support/(boot|http|in-process-postgres|postgres-snapshot)\\.ts$", "/node_modules/@electric-sql/pglite/"] },
    },
    {
      name: "ui-tests-import-the-composition-root-for-its-types",
      severity: "error",
      from: { path: "^apps/api/test/ui/" },
      to: { path: "^apps/api/src/composition-root\\.ts$", dependencyTypesNot: ["type-only"] },
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
