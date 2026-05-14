import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextRequest } from "next/server";

// Create a new ratelimiter that allows 50 requests per day per IP per endpoint
export const getRateLimiter = (endpoint: string) => {
  // Check if we're in a production environment to apply rate limiting
  // In development, we don't want to be rate limited for testing
  if (process.env.NODE_ENV !== "production" && !process.env.UPSTASH_REDIS_REST_URL) {
    return null;
  }

  // Requires the following environment variables:
  // UPSTASH_REDIS_REST_URL
  // UPSTASH_REDIS_REST_TOKEN
  const redis = Redis.fromEnv();

  return new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(50, "1 d"),
    analytics: true,
    prefix: `ratelimit:${endpoint}`,
  });
};

// Helper function to get the IP from a NextRequest or default to a placeholder
export const getIP = (request: NextRequest): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  
  if (forwarded) {
    return forwarded.split(/, /)[0];
  }
  
  if (realIp) {
    return realIp;
  }
  
  // Default to placeholder IP if none found
  return "127.0.0.1";
};

// Helper function to check if a request is rate limited
export const isRateLimited = async (request: NextRequest, endpoint: string) => {
  const limiter = getRateLimiter(endpoint);
  
  // If no limiter is available (e.g., in development), allow the request
  if (!limiter) {
    return { success: true, limit: 50, remaining: 50 };
  }
  
  // Get the IP from the request
  const ip = getIP(request);
  
  // Check if the IP has exceeded the rate limit
  const result = await limiter.limit(ip);
  
  return {
    success: result.success,
    limit: result.limit,
    remaining: result.remaining,
  };
}; 