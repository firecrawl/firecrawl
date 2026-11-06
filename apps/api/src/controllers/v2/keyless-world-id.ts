import { Request, Response } from "express";
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { isKeylessIpEligible, normalizeKeylessIpv4 } from "../../lib/keyless";
import {
  isWorldIdConfigured,
  pollWorldIdDeviceFlow,
  startWorldIdDeviceFlow,
} from "../../lib/world-id";
import { keylessClientIp } from "../auth";

// Starts and polls call the World ID issuer with our client credentials,
// which carry a per-client limit, so one caller must not be able to use it up.
// Callers are keyed like the keyless tier: one bucket per canonical IPv4, and
// one shared, larger bucket for every other address (IPv6 rotates too cheaply
// to key on). A poll budget covers one full attempt at the issuer's 5s
// interval over the 20 minutes a device code lives.
const limiter = (keyPrefix: string, points: number, duration: number) =>
  new RateLimiterRedis({
    storeClient: redisRateLimitClient,
    keyPrefix,
    points,
    duration,
  });
const throttles = {
  start: {
    ipv4: limiter("keyless_world_id_start", 10, 3600),
    shared: limiter("keyless_world_id_start_shared", 100, 3600),
  },
  poll: {
    ipv4: limiter("keyless_world_id_poll", 300, 1200),
    shared: limiter("keyless_world_id_poll_shared", 3000, 1200),
  },
};

/** Consumes one point for the caller; answers 429 and returns false when out. */
async function throttle(
  req: Request,
  res: Response,
  kind: keyof typeof throttles,
): Promise<boolean> {
  const ip = keylessClientIp(req);
  const ipv4 = isKeylessIpEligible(ip);
  try {
    await (ipv4 ? throttles[kind].ipv4 : throttles[kind].shared).consume(
      ipv4 ? normalizeKeylessIpv4(ip) : "shared",
    );
    return true;
  } catch (error) {
    if (error instanceof RateLimiterRes) {
      res
        .status(429)
        .setHeader("Retry-After", Math.ceil(error.msBeforeNext / 1000))
        .json({ success: false, error: "slow_down" });
      return false;
    }
    throw error;
  }
}

/**
 * Start World ID verification for the keyless tier (OIDC device flow). The
 * response carries the code and link to show the human, plus an opaque
 * `device_handle` to poll /v2/keyless/world-id/token with.
 */
export async function keylessWorldIdDeviceController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isWorldIdConfigured()) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }

  if (!(await throttle(req, res, "start"))) return;

  const start = await startWorldIdDeviceFlow();
  if (!start.ok) {
    res.status(start.status).json({ success: false, error: start.error });
    return;
  }
  res.status(200).json({
    success: true,
    device_handle: start.deviceHandle,
    user_code: start.userCode,
    verification_uri: start.verificationUri,
    ...(start.verificationUriComplete
      ? { verification_uri_complete: start.verificationUriComplete }
      : {}),
    expires_in: start.expiresIn,
    interval: start.interval,
  });
}

/**
 * Poll a World ID verification. Pending and terminal states use the RFC 8628
 * error codes (`authorization_pending`, `slow_down`, `access_denied`,
 * `expired_token`, ...). On approval it returns the `fcwid_` credential to
 * send as `x-firecrawl-world-id` on keyless requests.
 */
export async function keylessWorldIdTokenController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isWorldIdConfigured()) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }

  if (!(await throttle(req, res, "poll"))) return;

  const result = await pollWorldIdDeviceFlow(req.body?.device_handle);
  switch (result.outcome) {
    case "approved":
      res.status(200).json({
        success: true,
        credential: result.credential,
        expires_at: new Date(result.expiresAt * 1000).toISOString(),
      });
      return;
    case "not_allowed":
      res.status(403).json({
        success: false,
        error: "subject_not_allowed",
        subject_hash: result.subjectHash,
      });
      return;
    case "error":
      res.status(result.status).json({ success: false, error: result.error });
      return;
  }
}
