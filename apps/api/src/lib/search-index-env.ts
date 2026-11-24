import { z } from "zod";
import { defineEnv } from "../service/env";

export const searchIndexEnv = defineEnv(
  "search-index",
  z.object({
    ENABLE_SEARCH_INDEX: z.stringbool().optional(),
    SEARCH_INDEX_SAMPLE_RATE: z.coerce.number().default(0.1),
    SEARCH_SERVICE_API_SECRET: z.string().optional(),
    SEARCH_SERVICE_URL: z.string().optional(),
  }),
);
