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
    "src/scraper/scrapeURL/engines/fire-engine/branding-script/**",
    // Additive type module for structured product extraction; consumers
    // (Document type, extractor, SDKs) are wired up in later tasks.
    "src/types/product.ts",
  ],
  ignoreDependencies: ["undici-types", "stripe"],
};

export default config;
