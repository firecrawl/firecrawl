import { z } from "zod";
import { defineEnv } from "../service/env";

export const cclogWorkerEnv = defineEnv(
  "cclog-worker",
  z.object({
    CCLOG_WORKER_HEARTBEAT_URL: z.string().optional(),
    CCLOG_WORKER_PORT: z.coerce.number().default(3013).catch(3013),
  }),
);
