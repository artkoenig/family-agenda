import js from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";

// Every rule from the sonarjs recommended set, disabled (used to exclude tests below).
const sonarjsOff = Object.fromEntries(Object.keys(sonarjs.configs.recommended.rules).map((rule) => [rule, "off"]));

export default tseslint.config(
  { ignores: ["**/node_modules/", "packages/adapters/drizzle/", ".stryker-tmp/"] },
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
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { module: "writable" } },
  },
);
