import { z } from "zod";
import { defineEnv } from "../service/env";

export const browserEnv = defineEnv(
  "browser",
  z.object({
    HANGAR_URL: z.url().optional(),
    LANGSMITH_API_KEY: z.string().optional(),
    LANGSMITH_PROJECT: z.string().optional(),
    LANGSMITH_ENDPOINT: z.string().optional(),
    LANGSMITH_TRACING: z.stringbool().optional(),
  }),
);
