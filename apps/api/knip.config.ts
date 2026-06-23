import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: [
        "src/services/worker/**/*.ts",
        "src/services/**/*-worker.ts",
        "src/**/*.test.ts",
        "src/__tests__/**/*.ts",
      ],
      project: ["src/**/*.ts"],
    },
  },
  ignore: [
    "native/**",
    "src/scraper/scrapeURL/fetch/branding-script/**",
    "src/lib/deterministicJson/**",
    "src/scraper/scrapeURL/enrich/deterministicJson.ts",
    "src/services/monitoring/results.ts",
    // Legacy auto-recharge files — kept but disabled (Autumn handles auto-recharge now)
    "src/services/billing/auto_charge.ts",
    "src/services/billing/issue_credits.ts",
    "src/services/billing/stripe.ts",
  ],
  ignoreDependencies: ["undici-types", "stripe", "@ai-sdk/xai", "jsonrepair"],
  ignoreIssues: {
    "src/controllers/v2/types.ts": ["exports"],
    "src/db/rpc.ts": ["exports"],
    "src/db/schema/index-db.ts": ["exports"],
    "src/db/schema/public.ts": ["exports"],
    "src/lib/index-cache-metrics.ts": ["exports"],
    "src/scraper/scrapeURL/parse/pdf/types.ts": ["exports"],
    "src/services/index-cache.ts": ["exports"],
    "src/services/index.ts": ["exports"],
    "src/services/monitoring/queue.ts": ["exports"],
    "src/services/monitoring/runner.ts": ["exports"],
  },
};

export default config;
