import { addDays, lastDayOf, type Event, type LocalDate } from "@family-agenda/domain";
import type { NewItem, StatedItem } from "./ports";

/** How many days an Event a Source states may be over and still be written as new, as far as a feed reaches back. */
export const statedEventDaysBack = 30;

/** Whether the Event's last day in the Family's time zone is before `day`. */
const endedBefore = (event: Event, day: LocalDate, timeZone: string): boolean => lastDayOf(event.span, timeZone) < day;

/**
 * Whether what a message states was over before the day it arrived, such as in mail an added
 * Source brings: an Event that ended or a Task whose Deadline passed. A Task without a Deadline never is.
 */
export function wasOverOnArrival(item: NewItem, arrivedOn: LocalDate, timeZone: string): boolean {
  if (item.kind === "event") return endedBefore(item.event, arrivedOn, timeZone);
  return item.task.deadline !== null && item.task.deadline < arrivedOn;
}

/** Whether a stated Item is an Event over for too long to be written as new. */
export function isLongOver(item: StatedItem, today: LocalDate, timeZone: string): boolean {
  return item.kind === "event" && endedBefore(item.event, addDays(today, -statedEventDaysBack), timeZone);
}
