import { z } from "zod";
import { defineEnv } from "../service/env";

export const changeTrackingEnv = defineEnv(
  "change-tracking",
  z.object({
    BIGTABLE_CHANGE_TRACKING_TABLE: z.string().optional(),
  }),
);
