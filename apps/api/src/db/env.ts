import { z } from "zod";
import { emptyStringAsUndefined } from "../config-helpers";
import { defineEnv } from "../service/env";

export const dbEnv = defineEnv(
  "db",
  z.object({
    DATABASE_URL: z.string().optional(),
    DATABASE_REPLICA_URL: z.string().optional(),
    // Pool sizing preset for this process (see db/pool-profiles.ts). Unset keeps
    // the historical pool settings; deployments opt into `api`, `worker` or
    // `utility` to keep connections warm within the pooler's client budget.
    DB_POOL_PROFILE: emptyStringAsUndefined(
      z.enum(["api", "worker", "utility"]),
    ),
  }),
);
