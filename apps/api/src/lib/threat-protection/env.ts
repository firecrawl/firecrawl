import { z } from "zod";
import { defineEnv } from "../../service/env";

export const threatProtectionEnv = defineEnv(
  "threat-protection",
  z.object({
    // Threat protection (enterprise domain risk blocking). "normal" mode uses
    // Google Web Risk. An unset key disables the provider (lookups then fail
    // per the org's failurePolicy).
    GOOGLE_WEB_RISK_API_KEY: z.string().optional(),
    GOOGLE_WEB_RISK_API_URL: z
      .string()
      .url()
      .default("https://webrisk.googleapis.com"),
    // Google Web Risk Update API sync tuning. ZDR: "normal" mode checks run
    // against a locally synced hash-prefix database (threatLists:computeDiff)
    // instead of sending URLs to Google, and verdicts are never persisted.
    //
    // Floor for how often threatLists:computeDiff may run per list. Google's
    // recommendedNextDiff is respected when it is later than this floor.
    THREAT_LIST_SYNC_MIN_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60),
    // A synced threat list older than this is treated as unavailable
    // (provider-failure semantics → the org's failurePolicy decides).
    THREAT_LIST_STALENESS_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(6 * 60 * 60),

    // Zscaler ZIA provider ("zscaler" threat protection mode). Base-URL
    // overrides exist for tests (mock ZIA server); production always uses the
    // real endpoints derived from the org's vanity domain and cloud name.
    ZSCALER_TOKEN_URL_OVERRIDE: z.string().url().optional(),
    ZSCALER_API_URL_OVERRIDE: z.string().url().optional(),
    PARTNER_EGRESS_PROXY_URL: z.string().url().optional(),
  }),
);
