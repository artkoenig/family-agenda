/** What a failed attempt is tried again after, and how often in all. */
export type LockTimeoutRetry = { attempts: number; pauseMs: number };

const defaultRetry: LockTimeoutRetry = { attempts: 3, pauseMs: 1_000 };

/** Postgres' `lock_not_available`: a statement waited longer than `lock_timeout` for a lock. */
const lockNotAvailable = "55P03";

/** Whether `error`, or the error a driver wrapped in it, is a lock timeout. */
function isLockTimeout(error: unknown): boolean {
  for (let current = error; typeof current === "object" && current !== null; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === lockNotAvailable) return true;
  }
  return false;
}

/**
 * Runs `run`, and again after a pause while it fails with a lock timeout, up to `attempts` in
 * all. A migration that timed out changed nothing, its transaction rolled back, so trying it again
 * is safe; any other error is thrown at once.
 */
export async function retriedOnLockTimeout<T>(run: () => Promise<T>, retry: LockTimeoutRetry = defaultRetry): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= retry.attempts || !isLockTimeout(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retry.pauseMs));
    }
  }
}
