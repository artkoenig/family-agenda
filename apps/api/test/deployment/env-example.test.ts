import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../../../${file}`, import.meta.url)), "utf8");

/** The variables compose.yaml takes from the environment, such as `PORT` in `${PORT:-8080}`. */
const variablesOfCompose = (text: string) => new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)[:}-]/g)].map((match) => match[1]));

/** The variables .env.example sets or shows, with or without a leading `#`. */
const variablesOfExample = (text: string) => new Set([...text.matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));

describe(".env.example", () => {
  const used = variablesOfCompose(read("compose.yaml"));
  const shown = variablesOfExample(read(".env.example"));

  it("shows every variable that compose.yaml takes from the environment", () => {
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((name) => !shown.has(name))).toEqual([]);
  });

  it("shows no variable that compose.yaml does not use", () => {
    expect([...shown].filter((name) => !used.has(name))).toEqual([]);
  });
});
