import { z } from "zod";
import { defineEnv } from "../../service/env";

export const indexWorkerEnv = defineEnv(
  "index-worker",
  z.object({
    PRECRAWL_TEAM_ID: z.string().optional(),
    WORKER_LOCK_DURATION: z.coerce.number().default(60000),
    WORKER_STALLED_CHECK_INTERVAL: z.coerce.number().default(30000),
  }),
);
