import type { Clock } from "@family-agenda/application";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
