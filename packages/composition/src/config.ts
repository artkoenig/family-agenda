/** How the Instance behaves. Everything that does I/O is in `Adapters`. */
export type ApplicationConfig = {
  /** The IANA time zone the Family lives in, such as `Europe/Berlin`; never the one of the process. */
  timeZone: string;
};

/** Reads the behaviour of the Instance from environment variables. */
export function readApplicationConfig(env: NodeJS.ProcessEnv = process.env): ApplicationConfig {
  const timeZone = env.TZ;
  if (!timeZone) throw new Error("TZ is not set. Set it to the Family's IANA time zone, such as Europe/Berlin.");
  return { timeZone };
}

/** Throws a clear error for a time zone Intl does not know. */
export function assertTimeZone(timeZone: string): void {
  if (!timeZone) throw new Error("The time zone is not set. Set it to an IANA time zone, such as Europe/Berlin.");
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error(`The time zone "${timeZone}" is not an IANA time zone, such as Europe/Berlin.`);
  }
}
