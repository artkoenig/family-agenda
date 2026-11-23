import { isTimeZone, timeZones } from "@family-agenda/domain";
import type { FamilyRepository } from "./ports";

export type TimeZoneDeps = { families: Pick<FamilyRepository, "timeZone" | "saveTimeZone"> };

export type ChangeTimeZoneResult = { ok: true } | { ok: false; problem: "unknown-time-zone" };

/**
 * The time zone the Family lives in, which an Admin chooses. It decides where the Agenda's days
 * and a Task's day start, how Extraction reads dates, and what plugins get as `timeZone`; changing
 * it converts nothing already stored.
 */
export function createTimeZoneAccess({ families }: TimeZoneDeps) {
  return {
    /** The stored time zone; the core stores a starting value before it wires the Family. */
    async current(): Promise<string> {
      const stored = await families.timeZone();
      if (stored === null) throw new Error("the Family has no time zone stored");
      return stored;
    },

    /** The IANA time zones an Admin may choose from. */
    choices: (): string[] => timeZones(),

    async change(timeZone: string): Promise<ChangeTimeZoneResult> {
      if (!isTimeZone(timeZone)) return { ok: false, problem: "unknown-time-zone" };
      await families.saveTimeZone(timeZone);
      return { ok: true };
    },
  };
}

export type TimeZoneAccess = ReturnType<typeof createTimeZoneAccess>;
