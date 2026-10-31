import { isTheme, type Theme } from "@family-agenda/domain";
import type { FamilyRepository } from "./ports";

export type DisplayDeps = {
  families: FamilyRepository;
};

export type SetThemeResult = { ok: true } | { ok: false; problem: "invalid-theme" };

/** How the pages look: their Theme. */
export function createDisplayAccess(deps: DisplayDeps) {
  const { families } = deps;

  return {
    async theme(): Promise<Theme> {
      return families.theme();
    },

    async setTheme(theme: string): Promise<SetThemeResult> {
      if (!isTheme(theme)) return { ok: false, problem: "invalid-theme" };
      await families.saveTheme(theme);
      return { ok: true };
    },
  };
}

export type DisplayAccess = ReturnType<typeof createDisplayAccess>;
