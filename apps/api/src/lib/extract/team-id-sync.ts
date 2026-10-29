import { eq } from "drizzle-orm";
import { dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { logger } from "../logger";

import { withAuth } from "../withAuth";

async function getTeamIdSyncBOriginal(teamId: string) {
  try {
    const data = await dbRr
      .select({ team_id: schema.eb_sync.team_id })
      .from(schema.eb_sync)
      .where(eq(schema.eb_sync.team_id, teamId))
      .limit(1);
    return data[0] ?? null;
  } catch (error) {
    logger.error("Error getting team id (sync b)", error);
    return null;
  }
}

export const getTeamIdSyncB = withAuth(getTeamIdSyncBOriginal, null);
