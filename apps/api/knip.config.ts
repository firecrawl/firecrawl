import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: [
        "src/index.ts",
        "src/harness.ts",
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
    // Shared type contract co-owned by concurrent threat-protection branches;
    // the provider/verdict types are consumed by the core-lib branch.
    "src/lib/threat-protection/types.ts",
  ],
  ignoreDependencies: ["undici-types", "stripe"],
};

export default config;
