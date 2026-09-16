import { config } from "../config";

export type ExtractV3AgentStatus = {
  success: true;
  id: string;
  status: "processing" | "success" | "failed";
  data?: unknown;
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
};

export async function getExtractV3AgentStatus(
  id: string,
): Promise<ExtractV3AgentStatus> {
  if (!config.EXTRACT_V3_BETA_URL) {
    throw new Error("Agent beta is not enabled.");
  }

  const response = await fetch(
    `${config.EXTRACT_V3_BETA_URL}/internal/extracts/${encodeURIComponent(id)}`,
    {
      headers: {
        Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Agent status service returned ${response.status}: ${await response.text()}`,
    );
  }

  return (await response.json()) as ExtractV3AgentStatus;
}
