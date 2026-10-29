import { config } from "../config";
import { redisRateLimitClient } from "../services/rate-limiter";
import { isKeylessTeamId } from "./keyless";
import { logger } from "./logger";

// Daily call budgets for the free Firecrawl indexes, per team and per UTC day,
// sized by plan. Every route into an index reserves from the same counter, so a
// team cannot raise its budget by switching between the direct endpoint, the
// search category and the Alexandria provider. A new route into an index (for
// example the `research` category on /search) must reserve here as well.

export type IndexName = "gov" | "research";

type IndexDailyReservation =
  | { ok: true; release: () => Promise<void> }
  | {
      ok: false;
      used: number;
      limit: number;
      requested: number;
      retryAfterSeconds: number;
      resetsAt: Date;
    };

const DISPLAY_NAMES: Record<IndexName, string> = {
  gov: "Government Index",
  research: "Research Index",
};

const UPGRADE_URL = "https://firecrawl.dev/pricing";

const BASE_CALLS_PER_DAY = 1000;

// Thresholds are the Autumn `rate_limits` grants: 500 is Growth, 1000 is
// Scale, and Enterprise grants more. A wrong threshold refuses or unlimits real
// teams, not just their queue order. `PLAN_PRIORITY_TIERS` in
// services/rate-limiter.ts keys on the same grants, and the Alexandria catalogue
// in firecrawl/exchange (`usageLimits` on the index providers) and the public
// rate-limits docs repeat these numbers; change them together.
const PLAN_TIERS: { minMultiplier: number; callsPerDay: number | null }[] = [
  { minMultiplier: 1000, callsPerDay: null },
  { minMultiplier: 500, callsPerDay: 2000 },
];

const REDIS_TIMEOUT_MS = 500;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Redis did not answer in time")),
        REDIS_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The team's daily calls per index for its rate-limit multiplier; null is unlimited. */
function indexCallsPerDay(rateLimitMultiplier: number): number | null {
  const tier = PLAN_TIERS.find(t => rateLimitMultiplier >= t.minMultiplier);
  return tier ? tier.callsPerDay : BASE_CALLS_PER_DAY;
}

export async function reserveIndexCalls(
  index: IndexName,
  teamId: string,
  rateLimitMultiplier: number,
  calls: number,
  now = new Date(),
): Promise<IndexDailyReservation> {
  const limit =
    (index === "gov"
      ? config.GOV_INDEX_CALLS_PER_DAY_OVERRIDES?.[teamId]
      : undefined) ?? indexCallsPerDay(rateLimitMultiplier);
  if (calls <= 0 || limit === null)
    return { ok: true, release: async () => {} };

  const day = now.toISOString().slice(0, 10);
  const resetAt = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) /
      1000,
  );
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(resetAt - now.getTime() / 1000),
  );
  // FROZEN: `index-daily-calls:gov:` holds live counters in production.
  // Renaming the key resets every team's count for the day.
  const key = `index-daily-calls:${index}:${teamId}:${day}`;
  const pending = Promise.resolve().then(() =>
    redisRateLimitClient.eval(
      `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local calls = tonumber(ARGV[1])
if current + calls > tonumber(ARGV[2]) then
  return {0, current}
end
redis.call("INCRBY", KEYS[1], calls)
redis.call("EXPIREAT", KEYS[1], ARGV[3])
return {1, current}
`,
      1,
      key,
      calls,
      limit,
      resetAt,
    ),
  ) as Promise<[number, number]>;

  let releasePromise: Promise<void> | undefined;
  const release = () =>
    (releasePromise ??= (async () => {
      try {
        await withTimeout(
          redisRateLimitClient.eval(
            `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
if current > 0 then
  redis.call("DECRBY", KEYS[1], math.min(current, tonumber(ARGV[1])))
end
return 1
`,
            1,
            key,
            calls,
          ),
        );
      } catch (error) {
        logger.warn("Index daily limit release failed", {
          index,
          teamId,
          error,
        });
      }
    })());

  try {
    const [admitted, used] = await withTimeout(pending);
    if (admitted === 1) return { ok: true, release };
    return {
      ok: false,
      used: Number(used),
      limit,
      requested: calls,
      retryAfterSeconds,
      resetsAt: new Date(resetAt * 1000),
    };
  } catch (error) {
    logger.warn("Index daily limit check failed; allowing request", {
      index,
      teamId,
      error,
    });
    let releaseScheduled = false;
    return {
      ok: true,
      release: async () => {
        if (releaseScheduled) return;
        releaseScheduled = true;
        void pending
          .then(([admitted]) => (admitted === 1 ? release() : undefined))
          .catch(() => {});
      },
    };
  }
}

/** The caller-facing fields of a refusal, shared by every route into an index. */
export function indexDailyLimitRefusal(
  index: IndexName,
  teamId: string,
  reservation: Extract<IndexDailyReservation, { ok: false }>,
) {
  const name = DISPLAY_NAMES[index];
  const totalMinutes = Math.max(
    1,
    Math.ceil(reservation.retryAfterSeconds / 60),
  );
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const resetsIn = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  const limit = reservation.limit.toLocaleString("en-US");
  const needs =
    reservation.requested > 1
      ? ` and this request needs ${reservation.requested.toLocaleString("en-US")}`
      : "";
  const error = isKeylessTeamId(teamId)
    ? `Daily ${name} limit reached: requests without an API key are limited to ${limit} a day${needs}. The limit resets at 00:00 UTC, in ${resetsIn}. Add an API key, and upgrade to Scale or Enterprise for unlimited calls: ${UPGRADE_URL}`
    : `Daily ${name} limit reached: your team has used ${reservation.used.toLocaleString("en-US")} of its ${limit} calls today${needs}. The limit resets at 00:00 UTC, in ${resetsIn}. Upgrade to Scale or Enterprise for unlimited ${name} calls: ${UPGRADE_URL}`;
  return {
    error,
    limit: reservation.limit,
    used: reservation.used,
    resetsAt: reservation.resetsAt.toISOString(),
    upgradeUrl: UPGRADE_URL,
  };
}
