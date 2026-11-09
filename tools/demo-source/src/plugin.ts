import type { PluginImplementation } from "@family-agenda/plugin-kit";
import { demoAttributes, demoOrigins } from "./index";

/**
 * The demo Source as a plugin container (ADR-0001): the same Items as the in-process plugin, which
 * a preview still mounts until the core calls plugins over HTTP.
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
    configuration: { version: 1, fields: [] },
    setupSteps: [],
    ingestion: { mode: "polling", suggestedIntervalSeconds: 3600 },
    silentApplies: false,
  },
  poll(context) {
    return {
      // The demo states every Item; it has no messages.
      sourceRecords: demoOrigins(new Date(context.now), context.timeZone).flatMap(({ externalId, attributes, content }) => (content.kind === "stated" ? [{ externalId, attributes, content }] : [])),
      syncCursor: null,
      attributes: { declared: [...demoAttributes], archived: [] },
    };
  },
};
