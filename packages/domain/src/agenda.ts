import { daysBetween, type LocalDate } from "./calendar";
import type { FamilyMemberId } from "./family-member";

export type AgendaId = string & { readonly __brand: "AgendaId" };

/** What an Agenda shows: a timeline of days, or a Task List. */
export const agendaKinds = ["timeline", "tasks"] as const;

export type AgendaKind = (typeof agendaKinds)[number];

export function isAgendaKind(value: string): value is AgendaKind {
  return (agendaKinds as readonly string[]).includes(value);
}

/** An Agenda's only settings are its kind, its preselected Family Members and its horizon. */
export type Agenda = {
  id: AgendaId;
  kind: AgendaKind;
  /** Whom the Agenda is for, and its quick filter offers; none means the whole Family. */
  preselected: FamilyMemberId[];
  /** How many days the timeline shows, today included; a Task List keeps it unused. */
  horizonDays: number;
  createdAt: Date;
};

export const horizonDaysRange = { min: 1, max: 31 };

export const defaultHorizonDays = 7;

export function isAcceptableHorizon(days: number): boolean {
  return Number.isInteger(days) && days >= horizonDaysRange.min && days <= horizonDaysRange.max;
}

/** At most how many days one timeline page shows, when scrolled past its horizon. */
export const maxTimelineDays = 366;

/** Whether the days from `first` to `last`, both included, can be shown as one timeline page. */
export function isAcceptableTimelineRange(first: LocalDate, last: LocalDate): boolean {
  const days = daysBetween(first, last) + 1;
  return days >= 1 && days <= maxTimelineDays;
}
