import { config } from "../config";
import type { db } from "../db/connection";
import { billTeam7 } from "../db/rpc";
import { autumnService } from "../services/autumn/autumn.service";
import {
  toAutumnBillingProperties,
  type BillingMetadata,
} from "../services/billing/types";
import type { BrowserSessionRow } from "./browser-sessions";
import { orgIdForTeam } from "./team-org";

// Session creation precedes any charge. Stop well before Autumn's default
// 24-hour key expiry, even if a previous charge's response/commit was lost.
const BILLING_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

export async function billBrowserSession(
  session: BrowserSessionRow,
  credits: number,
  billing: Pick<BillingMetadata, "endpoint" | "jobId">,
  tx: Pick<typeof db, "execute">,
) {
  if (
    !config.USE_DB_AUTHENTICATION ||
    session.team_id === "preview" ||
    session.team_id.startsWith("preview_")
  )
    return;

  if (config.AUTUMN_SECRET_KEY) {
    const createdAt = Date.parse(session.created_at);
    if (
      !Number.isFinite(createdAt) ||
      Date.now() >= createdAt + BILLING_RETRY_WINDOW_MS
    ) {
      throw new Error(
        `Browser billing retry window expired for ${session.id}; manual reconciliation required.`,
      );
    }
    const orgId = await orgIdForTeam(session.team_id);
    if (!orgId)
      throw new Error("Browser billing could not resolve the team's org.");
    const tracked = await autumnService.trackCredits(
      {
        teamId: session.team_id,
        orgId,
        value: credits,
        properties: {
          source: "billTeam",
          ...toAutumnBillingProperties(billing),
          apiKeyId: null,
        },
        idempotencyKey: `fc:track:${billing.endpoint}:${session.id}:destroy`,
      },
      { idempotent: true },
    );
    if (!tracked) throw new Error("Browser billing was not confirmed.");
  }

  // No queue or compensating refund: a failed session transaction rolls back
  // this debit too, and the external charge reuses its key on the next attempt.
  await billTeam7(
    {
      team_id: session.team_id,
      subscription_id: null,
      credits,
      api_key_id: null,
      is_extract: false,
    },
    tx,
  );
}
