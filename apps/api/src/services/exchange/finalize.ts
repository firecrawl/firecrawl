import { getACUCTeam } from "../../controllers/auth";
import { logger } from "../../lib/logger";
import { autumnService } from "../autumn/autumn.service";
import { firebillConfigured, firebillFinalize } from "../autumn/firebill";
import type { FinalizeCreditsLockParams } from "../autumn/types";

export async function finalizeExchangeHold(
  input: FinalizeCreditsLockParams,
): Promise<boolean> {
  if (!input.externalRequestId) return autumnService.finalizeCreditsLock(input);
  if (!input.teamId || !firebillConfigured()) return false;
  try {
    const customerId = (await getACUCTeam(input.teamId))?.org_id;
    if (!customerId) return false;
    // Exchange has durable recovery, so partner attribution must resolve before settlement.
    return await firebillFinalize({ ...input, customerId });
  } catch (error) {
    logger.error("Exchange hold finalization will retry", {
      teamId: input.teamId,
      error,
    });
    return false;
  }
}
