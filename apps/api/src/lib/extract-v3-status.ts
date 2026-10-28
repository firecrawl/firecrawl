import { config } from "../config";
import type { ErrorCodes } from "./error";

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
  ) {
    super(message);
    this.name = "ExtractV3AgentStatusError";
  }
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
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const text = await response.text();
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
    throw new Error(
      `Agent status service returned ${response.status}: ${text}`,
    );
  }

  return (await response.json()) as ExtractV3AgentStatus;
}
