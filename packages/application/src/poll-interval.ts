/** How often an Admin may have a Source polled. */
export const pollIntervalRange = { minSeconds: 60, maxSeconds: 7 * 24 * 60 * 60 };

/** Whether an Admin's polling interval is allowed; null asks for the plugin's suggestion. */
export function isPollInterval(seconds: number | null | undefined): boolean {
  return (
    seconds == null || (Number.isInteger(seconds) && seconds >= pollIntervalRange.minSeconds && seconds <= pollIntervalRange.maxSeconds)
  );
}
