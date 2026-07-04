import { createHmac, randomUUID } from "crypto";
import undici from "undici";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import {
  getSecureDispatcherNoCookies,
  isIPPrivate,
} from "../../scraper/scrapeURL/engines/utils/safeFetch";
import {
  getOrgThreatProtectionConfig,
  type OrgThreatProtectionSiemConfig,
} from "../../lib/threat-protection/store";
import type { ThreatCheckEvent } from "../../lib/threat-protection/logging";
import { logWebhook } from "./delivery";

// SIEM push for threat protection security events (ENG-4987). A thin sibling
// of WebhookSender: WebhookSender is coupled to per-job webhooks (job id in
// the payload envelope, per-job config/secret, RabbitMQ queue messages that
// carry no signing secret), while SIEM delivery is org-level, batched, and
// signed with the org's siem_secret — so this module delivers directly.
//
// Reliability posture mirrors existing webhook delivery:
//  * HMAC-SHA256 signature in X-Firecrawl-Signature (same scheme)
//  * private-IP destinations blocked unless ALLOW_LOCAL_WEBHOOKS
//  * per-batch retries with backoff
//  * every delivery outcome is recorded in webhook_logs via logWebhook()
//
// Batching: events buffer per org and flush when the buffer reaches
// THREAT_SIEM_BATCH_SIZE (default 50) or after THREAT_SIEM_FLUSH_INTERVAL_MS
// (default 5000ms), whichever comes first — a high-volume org never gets one
// POST per check. The org's SIEM config is resolved at flush time (60s
// Redis-cached), so config changes apply without a restart; orgs without a
// SIEM destination simply have their buffer dropped on flush.

const logger = _logger.child({ module: "siem-sender" });

const MAX_BUFFERED_EVENTS_PER_ORG = 5000;
const DELIVERY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [500, 2000];
const DELIVERY_TIMEOUT_MS = 10000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OrgBuffer {
  events: ThreatCheckEvent[];
  timer: NodeJS.Timeout | null;
  flushing: boolean;
}

const buffers = new Map<string, OrgBuffer>();

interface SiemDeliveryResult {
  delivered: boolean;
  statusCode?: number;
  error?: string;
}

interface SiemBatchPayload {
  /** "threat_protection.check_batch" | "threat_protection.test" */
  type: string;
  batchId: string;
  sentAt: string;
  /** Present (true) only on synthetic test events. */
  test?: true;
  events: ThreatCheckEvent[];
}

/**
 * Buffers a threat check event for SIEM delivery. Fire-and-forget and
 * synchronous — never throws, never blocks the enforcement path.
 */
export function enqueueSiemThreatEvent(
  orgId: string,
  event: ThreatCheckEvent,
): void {
  let buffer = buffers.get(orgId);
  if (!buffer) {
    buffer = { events: [], timer: null, flushing: false };
    buffers.set(orgId, buffer);
  }

  buffer.events.push(event);

  if (buffer.events.length > MAX_BUFFERED_EVENTS_PER_ORG) {
    const dropped = buffer.events.splice(
      0,
      buffer.events.length - MAX_BUFFERED_EVENTS_PER_ORG,
    );
    logger.warn("SIEM buffer overflow; dropping oldest events", {
      orgId,
      droppedCount: dropped.length,
    });
  }

  if (buffer.events.length >= config.THREAT_SIEM_BATCH_SIZE) {
    void flushOrgBuffer(orgId);
  } else if (!buffer.timer) {
    buffer.timer = setTimeout(() => {
      void flushOrgBuffer(orgId);
    }, config.THREAT_SIEM_FLUSH_INTERVAL_MS);
    buffer.timer.unref?.();
  }
}

async function flushOrgBuffer(orgId: string): Promise<void> {
  const buffer = buffers.get(orgId);
  if (!buffer) return;
  if (buffer.timer) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }
  // Serialize flushes per org so batches arrive in order and we don't
  // double-deliver when a size-triggered flush races the interval timer.
  if (buffer.flushing) return;
  buffer.flushing = true;

  try {
    while (buffer.events.length > 0) {
      const events = buffer.events.splice(0);

      let siem: OrgThreatProtectionSiemConfig | null;
      try {
        siem = (await getOrgThreatProtectionConfig(orgId))?.siem ?? null;
      } catch (error) {
        logger.warn("Failed to load SIEM config; dropping buffered events", {
          orgId,
          error,
          eventCount: events.length,
        });
        continue;
      }
      if (!siem?.url) continue; // No SIEM destination — drop.

      const toSend =
        siem.events === "all"
          ? events
          : events.filter(event => event.decision === "blocked");

      for (let i = 0; i < toSend.length; i += config.THREAT_SIEM_BATCH_SIZE) {
        const chunk = toSend.slice(i, i + config.THREAT_SIEM_BATCH_SIZE);
        const payload: SiemBatchPayload = {
          type: "threat_protection.check_batch",
          batchId: randomUUID(),
          sentAt: new Date().toISOString(),
          events: chunk,
        };
        await deliverSiemPayload(orgId, siem, payload, {
          attempts: DELIVERY_ATTEMPTS,
        });
      }
    }
  } catch (error) {
    logger.error("SIEM flush failed", { orgId, error });
  } finally {
    buffer.flushing = false;
    if (buffer.events.length > 0) {
      // Events that raced in while we were finishing up: make sure a flush
      // is scheduled for them.
      if (!buffer.timer) {
        buffer.timer = setTimeout(() => {
          void flushOrgBuffer(orgId);
        }, config.THREAT_SIEM_FLUSH_INTERVAL_MS);
        buffer.timer.unref?.();
      }
    } else if (!buffer.timer) {
      buffers.delete(orgId);
    }
  }
}

/**
 * Sends one clearly-marked synthetic test event to the org's configured SIEM
 * destination and reports the delivery outcome. Used by
 * POST /v2/team/threat-protection/test-siem.
 */
export async function sendSiemTestEvent(
  orgId: string,
  teamId: string,
  siem: OrgThreatProtectionSiemConfig,
): Promise<SiemDeliveryResult> {
  const now = new Date().toISOString();
  const payload: SiemBatchPayload = {
    type: "threat_protection.test",
    batchId: randomUUID(),
    sentAt: now,
    test: true,
    events: [
      {
        event_id: randomUUID(),
        event_time: now,
        team_id: teamId,
        org_id: orgId,
        request_id: "",
        job_id: "",
        crawl_id: "",
        endpoint: "test-siem",
        url: "",
        url_domain: "threat-protection-test.invalid",
        mode: "normal",
        provider: "",
        risk_score: null,
        categories: ["TEST_EVENT"],
        domain_age_days: null,
        country_code: "",
        decision: "blocked",
        rule: "siem-test",
        provider_consulted: false,
        from_cache: false,
        origin: "siem-test",
        zero_data_retention: false,
      },
    ],
  };

  return await deliverSiemPayload(orgId, siem, payload, { attempts: 1 });
}

async function deliverSiemPayload(
  orgId: string,
  siem: OrgThreatProtectionSiemConfig,
  payload: SiemBatchPayload,
  opts: { attempts: number },
): Promise<SiemDeliveryResult> {
  let destinationHost: string;
  try {
    destinationHost = new URL(siem.url).hostname;
  } catch {
    return { delivered: false, error: "Invalid SIEM destination URL" };
  }

  if (isIPPrivate(destinationHost) && config.ALLOW_LOCAL_WEBHOOKS !== true) {
    logger.warn("Aborting SIEM delivery to private IP address", {
      orgId,
      siemUrl: siem.url,
    });
    return {
      delivered: false,
      error: "SIEM destination resolves to a private address",
    };
  }

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (siem.secret) {
    const hmac = createHmac("sha256", siem.secret);
    hmac.update(body);
    headers["X-Firecrawl-Signature"] = `sha256=${hmac.digest("hex")}`;
  }

  let result: SiemDeliveryResult = { delivered: false };
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      const res = await undici.fetch(siem.url, {
        method: "POST",
        headers,
        body,
        dispatcher: getSecureDispatcherNoCookies(),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      result = { delivered: res.ok, statusCode: res.status };
      if (res.ok) break;
      result.error = `Unexpected response status: ${res.status}`;
    } catch (error) {
      result = {
        delivered: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!result.delivered && attempt < opts.attempts) {
      const backoff =
        RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }

  if (!result.delivered) {
    logger.error("Failed to deliver SIEM payload", {
      orgId,
      siemUrl: siem.url,
      eventType: payload.type,
      eventCount: payload.events.length,
      statusCode: result.statusCode,
      error: result.error,
    });
  }

  // Make the outcome visible in webhook logs (same sink as regular webhook
  // delivery). webhook_logs.team_id/crawl_id are UUID columns — use the
  // events' team id where available and the batch id as the correlation id.
  const logTeamId = payload.events.find(event =>
    UUID_RE.test(event.team_id),
  )?.team_id;
  if (logTeamId) {
    await logWebhook({
      success: result.delivered,
      teamId: logTeamId,
      crawlId: payload.batchId,
      url: siem.url,
      event: payload.type,
      statusCode: result.statusCode,
      error: result.error,
    });
  }

  return result;
}
