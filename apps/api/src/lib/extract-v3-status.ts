import { config } from "../config";
import type { ErrorCodes } from "./error";
import { logger } from "./logger";

type ExtractV3AgentStatus = {
  success: true;
  id: string;
  status: "processing" | "success" | "failed";
  data?: unknown;
  /** Incomplete JSON from an interrupted run; never a completed `data` value. */
  partial?: unknown;
  partialSchemaValid?: boolean;
  stopReason?: "credit_limit_reached";
  error?: string;
  model?: "spark-1-pro" | "spark-1-mini" | "spark-2";
  effort?: "low" | "medium" | "high";
  safe?: boolean;
  threadId?: string;
  threadTurn?: number;
  mode?: "extract" | "chat";
  message?: string;
  suggestions?: unknown[];
  pendingApproval?: unknown;
  exchange?: unknown;
  creditsUsed?: number;
  /** When a finished run reached its terminal state. */
  completedAt?: string;
};

/**
 * The agent service answered with an error the caller should see as is, such
 * as 410 zdr_expired once a zero data retention run's result is deleted.
 */
export class ExtractV3AgentStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCodes,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ExtractV3AgentStatusError";
  }
}

const AGENT_STATUS_ATTEMPTS = 2;
const AGENT_STATUS_RETRY_AFTER_SECONDS = 2;
const RETRYABLE_UPSTREAM_STATUS = new Set([502, 503, 504]);

const AGENT_STATUS_UNAVAILABLE_ERROR =
  "Agent status is temporarily unavailable. Retry the request.";

export function agentStatusUnavailable(): ExtractV3AgentStatusError {
  return new ExtractV3AgentStatusError(
    503,
    "agent_status_unavailable",
    AGENT_STATUS_UNAVAILABLE_ERROR,
    AGENT_STATUS_RETRY_AFTER_SECONDS,
  );
}

function agentJobNotFound(): ExtractV3AgentStatusError {
  return new ExtractV3AgentStatusError(
    404,
    "agent_not_found",
    "Agent job not found",
  );
}

// A timeout already consumed the request budget. Retrying it would hold the
// caller for another full wait. A dropped connection or a 502/503/504 has not.
function isRequestTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function isAgentStatusBody(body: unknown): body is ExtractV3AgentStatus {
  return (
    body !== null &&
    typeof body === "object" &&
    typeof (body as { status?: unknown }).status === "string"
  );
}

export async function getExtractV3AgentStatus(
  id: string,
): Promise<ExtractV3AgentStatus> {
  if (!config.EXTRACT_V3_BETA_URL) {
    throw new Error("Agent beta is not enabled.");
  }

  const url = new URL(
    `${config.EXTRACT_V3_BETA_URL.replace(/\/$/, "")}/internal/extracts/${encodeURIComponent(id)}`,
  );

  let lastUnavailable: ExtractV3AgentStatusError | null = null;
  for (let attempt = 1; attempt <= AGENT_STATUS_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      logger.warn("Agent status service request failed", {
        error,
        jobId: id,
        attempt,
      });
      const unavailable = agentStatusUnavailable();
      // One more try for a dropped connection. A timeout has already used
      // the caller's wait, so it is returned as a retryable 503.
      if (isRequestTimeout(error) || attempt === AGENT_STATUS_ATTEMPTS) {
        throw unavailable;
      }
      lastUnavailable = unavailable;
      continue;
    }

    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        logger.warn("Agent status service returned unreadable JSON", {
          error,
          jobId: id,
          attempt,
        });
        lastUnavailable = agentStatusUnavailable();
        // A timeout while reading the body has already used this attempt's
        // wait. Starting another request would hold the caller for a second
        // full timeout.
        if (isRequestTimeout(error) || attempt === AGENT_STATUS_ATTEMPTS) {
          throw lastUnavailable;
        }
        continue;
      }
      if (!isAgentStatusBody(body)) {
        logger.warn("Agent status service returned an unexpected body", {
          jobId: id,
          attempt,
        });
        lastUnavailable = agentStatusUnavailable();
        if (attempt === AGENT_STATUS_ATTEMPTS) throw lastUnavailable;
        continue;
      }
      return body;
    }

    let text = "";
    try {
      text = await response.text();
    } catch (error) {
      // The status is already known. Only a retryable status needs the body
      // ignored in favor of a 503; a 404 or 410 must keep its own response,
      // and a timeout has already spent this attempt's wait.
      if (
        isRequestTimeout(error) &&
        RETRYABLE_UPSTREAM_STATUS.has(response.status)
      ) {
        logger.warn("Agent status service error body timed out", {
          error,
          jobId: id,
          attempt,
          status: response.status,
        });
        throw agentStatusUnavailable();
      }
    }
    if (response.status === 404) {
      throw agentJobNotFound();
    }
    if (response.status === 410) {
      let body: { code?: unknown; error?: unknown } | null = null;
      try {
        body = JSON.parse(text);
      } catch {}
      if (body?.code === "zdr_expired") {
        throw new ExtractV3AgentStatusError(
          410,
          "zdr_expired",
          typeof body.error === "string"
            ? body.error
            : "This zero data retention agent run's result has been deleted.",
        );
      }
    }
    if (RETRYABLE_UPSTREAM_STATUS.has(response.status)) {
      logger.warn("Agent status service unavailable", {
        status: response.status,
        jobId: id,
        attempt,
      });
      lastUnavailable = agentStatusUnavailable();
      if (attempt === AGENT_STATUS_ATTEMPTS) throw lastUnavailable;
      continue;
    }
    throw new Error(
      `Agent status service returned ${response.status}: ${text}`,
    );
  }

  throw lastUnavailable ?? agentStatusUnavailable();
}
