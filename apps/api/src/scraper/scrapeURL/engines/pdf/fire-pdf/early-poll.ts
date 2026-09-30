// Page-count-aware early polling for the async client.
//
// Backoff from a 1s floor (1s, 3s, 7s, 12s, ...) lands far from the moment a
// short document finishes, so its result sits unseen until the next poll. When
// the caller has a page estimate, the expected pipeline time is known well
// enough to do better: one poll around the typical finish time, then a short
// fixed interval through the slow tail, then the regular backoff.
//
// Self-contained on purpose: a server-side long-poll makes this schedule
// unnecessary, and removing it is deleting this file plus its one call in
// poll.ts.

import { POLL_CAP_MS } from "./schema";

type PipelineBucket = {
  /** Inclusive upper bound of the page estimate this row applies to. */
  maxPages: number;
  /** Typical pipeline time: where the first poll lands. */
  p50Ms: number;
  /** Slow-tail pipeline time: where fast polling stops. */
  p90Ms: number;
};

const PIPELINE_BUCKETS: readonly PipelineBucket[] = [
  { maxPages: 1, p50Ms: 1_000, p90Ms: 3_000 },
  { maxPages: 5, p50Ms: 1_200, p90Ms: 5_000 },
  { maxPages: 10, p50Ms: 2_500, p90Ms: 9_700 },
  { maxPages: 25, p50Ms: 4_400, p90Ms: 14_900 },
  { maxPages: 50, p50Ms: 5_200, p90Ms: 19_500 },
  { maxPages: 100, p50Ms: 11_800, p90Ms: 31_000 },
];

const FAST_POLL_MS = 300;
const JITTER = 0.2;
/** Hard floor on any early poll, whatever the constants above say. */
const MIN_EARLY_POLL_MS = 250;
/** Bounds the extra requests one job can cause, however long its tail. */
const MAX_FAST_POLLS = 30;

type EarlyPollState = {
  pagesEstimate: number | undefined;
  /** Time since polling began. */
  elapsedMs: number;
  /** Polls already sent (the first poll is number 0). */
  pollCount: number;
  /** Polls already sent on the fast interval. */
  fastPollCount: number;
  /** fire-pdf's own requested delay; wins whenever it is larger. */
  retryAfterMs: number | undefined;
  random: () => number;
};

/**
 * The delay before the next poll while the job is inside its expected
 * pipeline window, or undefined once the regular backoff should take over
 * (no page estimate, a document beyond the table, past the slow tail, or
 * out of fast polls).
 */
export function earlyPollDelay(state: EarlyPollState): number | undefined {
  const { pagesEstimate } = state;
  if (pagesEstimate === undefined || !(pagesEstimate > 0)) return undefined;
  const bucket = PIPELINE_BUCKETS.find(b => pagesEstimate <= b.maxPages);
  if (!bucket) return undefined;

  let base: number;
  if (state.pollCount === 0) {
    base = bucket.p50Ms;
  } else if (
    state.elapsedMs < bucket.p90Ms &&
    state.fastPollCount < MAX_FAST_POLLS
  ) {
    base = FAST_POLL_MS;
  } else {
    return undefined;
  }
  const jittered = Math.round(base * (1 + state.random() * JITTER));
  // A fire-pdf hint is honoured up to the same ceiling as the backoff, so a
  // large one never stretches a poll beyond what it could before.
  const hint = Math.min(POLL_CAP_MS, state.retryAfterMs ?? 0);
  return Math.max(MIN_EARLY_POLL_MS, jittered, hint);
}
