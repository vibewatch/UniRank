/** Jittered exponential backoff — ported from ReadWise's `src/lib/backoff.ts`. */

export interface BackoffArgs {
  /** 1-based retry attempt number. */
  attempt: number;
  baseMs: number;
  maxMs: number;
  random?: () => number;
}

/**
 * Returns a delay of `min(maxMs, baseMs * 2**(attempt-1))` with additive
 * "full jitter" up to that value, so concurrent retries don't run in lockstep.
 */
export function jitteredExponentialBackoff({
  attempt,
  baseMs,
  maxMs,
  random = Math.random,
}: BackoffArgs): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = random() * exponential;
  return Math.min(maxMs, Math.round(jitter));
}

/**
 * Seconds-based jittered backoff matching the original scraper's `_retry_delay`
 * (`base * 2**attempt` capped at `cap`, plus additive jitter up to `base`).
 * `attempt` here is 0-based, as in the Python loop.
 */
export function retryDelaySeconds(
  baseDelay: number,
  attempt: number,
  cap = 30,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(cap, baseDelay * 2 ** attempt);
  return exponential + random() * baseDelay;
}
