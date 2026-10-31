/** How the pages look: always light, always dark, or as the device they are shown on prefers. */
export const themes = ["system", "light", "dark"] as const;

export type Theme = (typeof themes)[number];

/** The Theme of an Instance that never chose one. */
export const defaultTheme: Theme = "system";

export function isTheme(text: string): text is Theme {
  return (themes as readonly string[]).includes(text);
}
