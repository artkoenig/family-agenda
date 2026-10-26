import type { Clock } from "@family-butler/application";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
