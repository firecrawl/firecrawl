import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { NextFunction, Request, Response } from "express";
import IPAddr from "ipaddr.js";
import { PubSub, type Topic } from "@google-cloud/pubsub";
import { config } from "../config";
import type { AuthCreditUsageChunk } from "../controllers/v1/types";
import { redisRateLimitClient } from "../services/rate-limiter";
import { routeOf } from "./auth-denied-log";
import { logger as _logger } from "./logger";
import { getScrapeZDR, getSearchZDR } from "./zdr-helpers";

type AccessEventKind =
  | "key_seen"
  | "key_rejected"
  | "admin_hit"
  | "admin_denied";

type AccessEvent = {
  kind: AccessEventKind;
  ip: string;
  ipTruncated: boolean;
  route?: string;
  method?: string;
  status?: number;
  userAgent?: string;
  teamId?: string;
  apiKeyId?: number;
  label?: string;
};

const logger = _logger.child({ module: "access-events" });

const KEY_SEEN_WINDOW_SECONDS = 3600;
const KEY_SEEN_LOCAL_MAX = 50_000;
const MAX_PENDING_PUBLISHES = 5_000;
const MAX_ROUTE_LENGTH = 256;
const ADMIN_OPEN_SEGMENTS = new Set(["acuc-cache-clear", "integration"]);

const pod = hostname();
const keySeenLocal = new Map<string, number>();
let topic: Topic | null | undefined;
const pendingPublishes = new Set<Promise<unknown>>();
let lastFailureWarningAt = 0;

function getTopic(): Topic | null {
  if (topic !== undefined) return topic;
  if (!config.ACCESS_EVENTS_TOPIC || !config.PUBSUB_CREDENTIALS) {
    return (topic = null);
  }
  try {
    const credentials = JSON.parse(
      Buffer.from(config.PUBSUB_CREDENTIALS, "base64").toString("utf8"),
    );
    return (topic = new PubSub({
      projectId: credentials.project_id,
      credentials,
    }).topic(config.ACCESS_EVENTS_TOPIC));
  } catch (error) {
    logger.error("Failed to initialize access event publisher", { error });
    return (topic = null);
  }
}

function publish(event: AccessEvent): void {
  const target = getTopic();
  if (!target || pendingPublishes.size >= MAX_PENDING_PUBLISHES) return;

  const payload = Buffer.from(
    JSON.stringify({
      id: randomUUID(),
      ts: new Date().toISOString(),
      env: config.ENV ?? "",
      pod,
      kind: event.kind,
      ip: event.ip,
      ip_truncated: event.ipTruncated,
      route: event.route ?? "",
      method: event.method ?? "",
      status: event.status ?? 0,
      ua: (event.userAgent ?? "").slice(0, 256),
      team_id: event.teamId ?? "",
      api_key_id: event.apiKeyId ?? 0,
      label: event.label ?? "",
    }),
  );

  const publication = target
    .publishMessage({ data: payload })
    .catch(error => {
      const now = Date.now();
      if (now - lastFailureWarningAt >= 60_000) {
        lastFailureWarningAt = now;
        logger.warn("Failed to publish access event", { error });
      }
    })
    .finally(() => {
      pendingPublishes.delete(publication);
    });
  pendingPublishes.add(publication);
}

/** The network an address belongs to: /24 for IPv4, /48 for IPv6. */
function networkOf(ip: string): string {
  if (!IPAddr.isValid(ip)) return "";
  const addr = IPAddr.process(ip);
  if (addr.kind() === "ipv4") {
    const [a, b, c] = (addr as IPAddr.IPv4).octets;
    return `${a}.${b}.${c}.0`;
  }
  const [a, b, c] = (addr as IPAddr.IPv6).parts;
  return new IPAddr.IPv6([a, b, c, 0, 0, 0, 0, 0]).toString();
}

function clientIp(req: Request): string {
  const ip = req.ip ?? req.socket?.remoteAddress ?? "";
  return IPAddr.isValid(ip) ? IPAddr.process(ip).toString() : "";
}

function userAgent(req: Request): string | undefined {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua : undefined;
}

function hasZeroDataRetention(chunk: AuthCreditUsageChunk): boolean {
  const flags = chunk.flags ?? undefined;
  return (
    getScrapeZDR(flags) !== "disabled" || getSearchZDR(flags) !== "disabled"
  );
}

/**
 * Label configured in API_KEY_DENYLIST for this key, if any. Keys are matched
 * by the SHA-256 of their lowercase dashed UUID form.
 */
export function denylistLabel(normalizedKey: string): string | undefined {
  const denylist = config.API_KEY_DENYLIST;
  if (!denylist) return undefined;
  const digest = createHash("sha256")
    .update(normalizedKey.toLowerCase())
    .digest("hex");
  return denylist[digest];
}

export function recordRejectedKey(req: Request, label: string): void {
  publish({
    kind: "key_rejected",
    ip: clientIp(req),
    ipTruncated: false,
    route: routeOf(req),
    method: req.method,
    status: 401,
    userAgent: userAgent(req),
    label,
  });
}

/**
 * Emits key_seen at most once per key and client network per hour. Teams with
 * zero data retention are skipped; only teams in ACCESS_EVENTS_FULL_IP_TEAM_IDS
 * keep the full client address.
 */
export function recordKeySeen(req: Request, chunk: AuthCreditUsageChunk): void {
  if (!getTopic() || !chunk.api_key_id || hasZeroDataRetention(chunk)) return;

  const ip = clientIp(req);
  const network = networkOf(ip);
  const dedupeKey = `access_evt:${chunk.api_key_id}:${network}`;
  const now = Date.now();
  const localExpiry = keySeenLocal.get(dedupeKey);
  if (localExpiry !== undefined && localExpiry > now) return;
  if (keySeenLocal.size >= KEY_SEEN_LOCAL_MAX) keySeenLocal.clear();
  const expiry = now + KEY_SEEN_WINDOW_SECONDS * 1000;
  keySeenLocal.set(dedupeKey, expiry);

  const fullIp =
    config.ACCESS_EVENTS_FULL_IP_TEAM_IDS?.includes(chunk.team_id) === true;
  const event: AccessEvent = {
    kind: "key_seen",
    ip: fullIp ? ip : network,
    ipTruncated: !fullIp,
    route: routeOf(req),
    method: req.method,
    userAgent: userAgent(req),
    teamId: chunk.team_id,
    apiKeyId: chunk.api_key_id,
  };

  redisRateLimitClient
    .set(dedupeKey, "1", "EX", KEY_SEEN_WINDOW_SECONDS, "NX")
    .then(result => {
      if (result === "OK") publish(event);
    })
    .catch(error => {
      if (keySeenLocal.get(dedupeKey) === expiry)
        keySeenLocal.delete(dedupeKey);
      logger.debug("Access event dedupe failed", { error });
    });
}

function adminRoute(path: string): { route: string; keyed: boolean } {
  const segments = path.split("/");
  const second = segments[2] ?? "";
  const keyed = !!config.BULL_AUTH_KEY && second === config.BULL_AUTH_KEY;
  const masked = segments.map((segment, index) => {
    if (config.BULL_AUTH_KEY && segment === config.BULL_AUTH_KEY) return ":key";
    if (index === 2 && !ADMIN_OPEN_SEGMENTS.has(segment)) return ":segment";
    return segment;
  });
  return { route: masked.join("/").slice(0, MAX_ROUTE_LENGTH), keyed };
}

/** Logs every /admin request with a masked route and emits an access event. */
export function adminAccessLog(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const { route, keyed } = adminRoute(req.originalUrl.split("?")[0]);
  const startedAt = Date.now();

  res.on("finish", () => {
    const open = ADMIN_OPEN_SEGMENTS.has(route.split("/")[2] ?? "");
    const hit =
      keyed || (open && res.statusCode !== 401 && res.statusCode !== 403);
    const ip = clientIp(req);

    logger.info("Admin route request", {
      canonicalLog: "admin/access",
      method: req.method,
      route,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });

    publish({
      kind: hit ? "admin_hit" : "admin_denied",
      ip: hit ? ip : networkOf(ip),
      ipTruncated: !hit,
      route,
      method: req.method,
      status: res.statusCode,
      userAgent: userAgent(req),
    });
  });

  next();
}

export async function shutdownAccessEvents(): Promise<void> {
  if (!topic) return;
  await Promise.allSettled([topic.flush(), ...pendingPublishes]);
}
