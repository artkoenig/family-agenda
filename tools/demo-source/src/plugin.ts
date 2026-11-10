import type { PluginImplementation } from "@family-agenda/plugin-kit";
import { demoAttributes, demoOrigins } from "./index";

/** The made-up calendars the demo's choice field offers. */
const demoCalendars = ["Family", "School", "Sports club"];

/**
 * The demo Source as a plugin container (ADR-0001), which only a preview runs.
 */
export const demoPlugin: PluginImplementation = {
  description: {
    sourceTypeId: "demo",
    kind: "stateless",
    displayName: { en: "Demo data", de: "Demodaten" },
    version: "0.1.0",
    description: {
      en: "States a week of made-up Events and Lessons, and two Tasks, around the run's date, for trying out a change in a preview. Never installed on a real Instance.",
      de: "Liefert eine Woche erfundener Termine und Unterrichtsstunden sowie zwei Aufgaben rund um das Datum des Laufs, um eine Änderung in einer Vorschau auszuprobieren. Wird nie auf einer echten Instanz installiert.",
    },
    needsLlm: false,
    configuration: {
      version: 1,
      fields: [
        {
          key: "calendars",
          label: { en: "Calendars", de: "Kalender" },
          description: {
            en: "Made up too: only there to show how a choice field loads.",
            de: "Ebenfalls erfunden: nur da, um zu zeigen, wie ein Auswahlfeld lädt.",
          },
          secret: false,
          required: false,
          hasChoices: true,
        },
      ],
    },
    setupSteps: [],
    ingestion: { mode: "polling", suggestedIntervalSeconds: 3600 },
    silentApplies: false,
  },
  sourceAdded() {
    return { plain: {}, secrets: {} };
  },
  sourceAttributes() {
    return { declared: [...demoAttributes], archived: [] };
  },
  fieldChoices() {
    return { choices: demoCalendars.map((name) => ({ value: name.toLowerCase(), label: name })) };
  },
  poll(context) {
    return {
      sourceRecords: demoOrigins(new Date(context.now), context.timeZone),
      syncCursor: null,
      attributes: { declared: [...demoAttributes], archived: [] },
    };
  },
};

/**
 * The plugin with each endpoint but `description` answering only after `delayMs`, so that a preview
 * shows the core's loading states.
 */
export function withDelay(plugin: PluginImplementation, delayMs: number): PluginImplementation {
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  const delayed = Object.entries(plugin).map(([name, value]) =>
    typeof value === "function"
      ? [name, async (request: unknown) => { await wait(); return (value as (r: unknown) => unknown)(request); }]
      : [name, value],
  );
  return Object.fromEntries(delayed) as PluginImplementation;
}
