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
    // Superseded by the integration proxy added in #3520; kept for now.
    "src/controllers/v0/admin/rotate-api-key.ts",
  ],
  ignoreDependencies: ["undici-types", "stripe"],
};

export default config;
