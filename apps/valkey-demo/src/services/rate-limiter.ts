import { getValkeyClient } from '../valkey-client';
import { config } from '../config';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Sliding window rate limiter using Valkey GLIDE
 * Demonstrates rate limiting pattern for API calls
 */
export class RateLimiter {
  private prefix = 'demo:ratelimit';
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests?: number, windowMs?: number) {
    this.maxRequests = maxRequests ?? config.rateLimit.max;
    this.windowMs = windowMs ?? config.rateLimit.windowMs;
  }

  async checkLimit(identifier: string): Promise<RateLimitResult> {
    const client = await getValkeyClient();
    const key = `${this.prefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Remove old entries outside the window
    await client.zremRangeByScore(key, { value: 0, isInclusive: true }, { value: windowStart, isInclusive: true });
    
    // Count current requests in window
    const currentCount = await client.zcard(key);
    
    const allowed = currentCount < this.maxRequests;
    
    if (allowed) {
      // Add current request
      await client.zadd(key, [{ element: `${now}-${Math.random()}`, score: now }]);
      // Set expiry on the key
      await client.pexpire(key, this.windowMs);
    }

    const remaining = Math.max(0, this.maxRequests - currentCount - (allowed ? 1 : 0));
    const resetAt = now + this.windowMs;

    return { allowed, remaining, resetAt };
  }

  async getRemainingRequests(identifier: string): Promise<number> {
    const client = await getValkeyClient();
    const key = `${this.prefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - this.windowMs;

    await client.zremRangeByScore(key, { value: 0, isInclusive: true }, { value: windowStart, isInclusive: true });
    const count = await client.zcard(key);
    
    return Math.max(0, this.maxRequests - count);
  }

  async resetLimit(identifier: string): Promise<void> {
    const client = await getValkeyClient();
    const key = `${this.prefix}:${identifier}`;
    await client.del([key]);
  }
}
