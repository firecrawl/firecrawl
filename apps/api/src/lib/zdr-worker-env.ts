import { z } from "zod";
import { defineEnv } from "../service/env";

export const zdrWorkerEnv = defineEnv(
  "zdr-worker",
  z.object({
    ZDRCLEANER_HEARTBEAT_URL: z.string().optional(),
  }),
);
