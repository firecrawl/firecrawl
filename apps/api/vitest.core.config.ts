import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// The core suite: unit tests that need no credentials and no running services.
// It runs every src/**/*.test.ts file that is not listed here, so a new test
// file joins the suite without being registered.
const outsideCoreSuite = [
  // Need a running API, a queue database, credentials or the public internet.
  "src/__tests__/e2e_*/**",
  "src/__tests__/nuq-fdb/**",
  "src/__tests__/nuq-postgres.test.ts",
  "src/__tests__/snips/v*/**",
  "src/lib/ranker.test.ts",
  "src/scraper/WebScraper/__tests__/dns.test.ts",
  "src/scraper/scrapeURL/scrapeURL.test.ts",

  // Run in dedicated CI steps or require additional runtime fixtures.
  "src/__tests__/routes/hosted-mcp-*.test.ts",
  "src/scraper/scrapeURL/engines/utils/specialtyHandler.test.ts",
  "src/search/execute.test.ts",
  "src/services/worker/crawl-logic.test.ts",
];

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: outsideCoreSuite,
      setupFiles: ["./vitest.core.setup.ts"],
    },
  }),
);
