import { config } from "../../config";
import { logger } from "../../lib/logger";

/**
 * Rolling window on hosted MCP credits. An org spends at most
 * `MCP_WINDOW_CREDITS` MCP credits per `MCP_WINDOW_HOURS`; the window opens on
 * its first MCP charge and closes that many hours later. The Autumn balance
 * behind MCP credits stays the longer-period cap. Charges past the window fall
 * back to the team's own credits, as charges past the Autumn balance do.
 *
 * Everything here fails open: an unreadable counter means no window.
 */

const windowMs = () => Math.round(config.MCP_WINDOW_HOURS * 60 * 60 * 1000);

export function mcpWindowEnabled(): boolean {
  return config.MCP_WINDOW_CREDITS > 0 && windowMs() > 0;
}

const key = (orgId: string) => `mcp_window:{${orgId}}`;

// Loaded on first use, so a process with the window off never opens the
// connection on this module's account.
const redis = async () =>
  (await import("../rate-limiter.js")).redisRateLimitClient;

// Adds to the org's counter, opening the window when there is none. A refund
// (negative delta) never opens a window and never takes the counter below 0.
const RECORD = `
local delta = tonumber(ARGV[1])
if delta < 0 and redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local used = redis.call('INCRBY', KEYS[1], delta)
if used < 0 then
  redis.call('SET', KEYS[1], 0, 'KEEPTTL')
  used = 0
end
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return used
`;

/** Counts MCP credits charged (or, negative, refunded) in the org's window. */
export async function recordMcpWindowUsage(
  orgId: string,
  credits: number,
): Promise<void> {
  if (!mcpWindowEnabled()) return;
  const delta = Math.round(credits);
  if (!Number.isFinite(delta) || delta === 0) return;
  try {
    await (await redis()).eval(RECORD, 1, key(orgId), delta, windowMs());
  } catch (error) {
    logger.warn("Failed to record MCP window usage", { orgId, credits, error });
  }
}

/**
 * The refusal the window gives a charge of `credits`, shaped like a credit
 * check's, or null when the window admits it (or is off or unreadable).
 * `resetsAt` is when the window closes.
 */
export async function checkMcpWindow(
  orgId: string,
  credits: number,
): Promise<{ allowed: false; remaining: number; resetsAt?: number } | null> {
  if (!mcpWindowEnabled()) return null;
  try {
    const client = await redis();
    const [used, ttl] = await Promise.all([
      client.get(key(orgId)),
      client.pttl(key(orgId)),
    ]);
    const spent = Math.max(0, Number(used ?? 0) || 0);
    if (spent + credits <= config.MCP_WINDOW_CREDITS) return null;
    return {
      allowed: false,
      remaining: Math.max(0, config.MCP_WINDOW_CREDITS - spent),
      ...(ttl > 0 ? { resetsAt: Date.now() + ttl } : {}),
    };
  } catch (error) {
    logger.warn("Failed to read MCP window usage", { orgId, error });
    return null;
  }
}

/** "2h 14m", "14m" or "under a minute" until `resetsAt` (epoch ms). */
export function formatResetCountdown(
  resetsAt: number,
  now: number = Date.now(),
): string {
  const minutes = Math.floor((resetsAt - now) / 60000);
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
