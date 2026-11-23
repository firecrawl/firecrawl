import { z } from "zod";
import { defineEnv } from "../service/env";

export const engpickerEnv = defineEnv(
  "engpicker",
  z.object({
    DISABLE_ENGPICKER: z.stringbool().optional(),
  }),
);
