import js from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";

// Every rule from the sonarjs recommended set, disabled (used to exclude tests below).
const sonarjsOff = Object.fromEntries(Object.keys(sonarjs.configs.recommended.rules).map((rule) => [rule, "off"]));

export default tseslint.config(
  { ignores: ["**/node_modules/", "packages/adapters/drizzle/", ".stryker-tmp/", ".previews/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    // SonarQube-style code smells.
    ...sonarjs.configs.recommended,
    rules: {
      ...sonarjs.configs.recommended.rules,
      // Stylistic / low-signal in TypeScript — disabled:
      "sonarjs/prefer-read-only-props": "off",
      "sonarjs/no-nested-conditional": "off",
      "sonarjs/no-nested-template-literals": "off",
      "sonarjs/no-alphabetical-sort": "off",
      "sonarjs/prefer-specific-assertions": "off",
    },
  },
  {
    // Code-smell rules do not apply to test files.
    files: ["**/test/**"],
    rules: sonarjsOff,
  },
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ["*.js", ".*.cjs"] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["**/test/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    // Two Instances live in one process without sharing state (ADR-0013): a library package reads
    // no environment, no working directory and no time zone of the process, and keeps no `let` at
    // module scope. `registerHooks` in the SourceRegistry is the one allowed global.
    files: ["packages/*/src/**/*.ts"],
    ignores: ["packages/source-matrix/**", "packages/composition/src/self-hosted.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "process", property: "env", message: "A library package gets its configuration as arguments; only the process (or selfHostedAdapters) reads process.env." },
        { object: "process", property: "cwd", message: "A library package gets its paths as arguments; only the process (or selfHostedAdapters) reads process.cwd()." },
        ...["getHours", "getMinutes", "getSeconds", "getDate", "getDay", "getMonth", "getFullYear", "getTimezoneOffset", "setHours", "setDate", "setMonth", "setFullYear", "toLocaleString", "toLocaleDateString", "toLocaleTimeString", "toDateString", "toTimeString"].map(
          (property) => ({ property, message: "This depends on the time zone of the process. Use the time zone of the Family (Intl.DateTimeFormat with timeZone, or UTC getters)." }),
        ),
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "Program > VariableDeclaration[kind='let']", message: "No mutable state at module scope: it would be shared by every Instance in the process. Keep it in the object an Instance creates." },
        { selector: "Program > ExportNamedDeclaration > VariableDeclaration[kind='let']", message: "No mutable state at module scope: it would be shared by every Instance in the process." },
        { selector: "CallExpression[callee.property.name='resolvedOptions'] > MemberExpression", message: "Do not read the time zone of the process." },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { module: "writable" } },
  },
);
