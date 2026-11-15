import js from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import { addressAttributes, redirectHeaders } from "./apps/api/src/http/addresses.js";

// Every rule from the sonarjs recommended set, disabled (used to exclude tests below).
const sonarjsOff = Object.fromEntries(Object.keys(sonarjs.configs.recommended.rules).map((rule) => [rule, "off"]));

// A root path written as it is (`"/admin"`, `` `/agendas/${id}` ``), not as an argument of `href`.
const rootPath = [
  'Literal[value=/^\\//]:not(CallExpression[callee.name="href"] Literal)',
  'TemplateLiteral[quasis.0.value.raw=/^\\//]:not(CallExpression[callee.name="href"] TemplateLiteral)',
];
const useHref = "Build the address with `href(prefix, path)` so that it lies below the path prefix.";
/** Where an address leaves the core: an attribute that names one, a redirect, its headers and a cookie path. */
const outsideThePrefix = [
  `JSXAttribute[name.name=/^(${addressAttributes.join("|")})$/]`,
  'CallExpression[callee.property.name="redirect"]',
  `CallExpression[callee.property.name="header"][arguments.0.value=/^(${redirectHeaders.join("|")})$/i]`,
  `Property[key.value=/^(${redirectHeaders.join("|")})$/i]`,
  'CallExpression[callee.name=/^(setCookie|deleteCookie|setSignedCookie)$/] Property[key.name="path"]',
].flatMap((where) => rootPath.map((path) => ({ selector: `${where} ${path}`, message: useHref })));

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
    // The path prefix (ADR-0004, docs/configuration.md): every address the web app emits is built with
    // `href(prefix, path)`, so that it lies below the prefix. A literal root path in a link, form,
    // background request, redirect or cookie would not; it fails here. Literals given to `href` are fine.
    files: ["apps/api/src/**"],
    rules: { "no-restricted-syntax": ["error", ...outsideThePrefix] },
  },

  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { module: "writable" } },
  },
);
