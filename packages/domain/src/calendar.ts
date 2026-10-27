/** A calendar date as `YYYY-MM-DD`, in the Family's time zone. */
export type LocalDate = string & { readonly __brand: "LocalDate" };

/** A wall-clock time as `HH:MM`, in the Family's time zone. */
export type LocalTime = string & { readonly __brand: "LocalTime" };

/** The date and time an instant shows on a clock in the given IANA time zone. */
export function localDateTime(at: Date, timeZone: string): { date: LocalDate; time: LocalTime } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}` as LocalDate,
    time: `${parts.hour}:${parts.minute}` as LocalTime,
  };
}

/** The date a number of days later; calendar days, so daylight saving time does not matter. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10) as LocalDate;
}

/** How many calendar days `to` lies after `from`; negative if before. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * 60 * 60 * 1000));
}

/** Whether a string is a real calendar date as `YYYY-MM-DD`. */
export function isLocalDate(value: string): value is LocalDate {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}
