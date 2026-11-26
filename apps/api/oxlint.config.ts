import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    "dist/**",
    "native/**",
    "sharedLibs/**",
  ],
  rules: {
    "@nkzw/no-instanceof": "off",
  },
  overrides: [
    {
      // Extension points extended via TypeScript declaration merging.
      files: [
        "src/service/hooks.ts",
        "src/service/modules.ts",
        "src/service/request.ts",
        "src/service/request-context.ts",
      ],
      rules: {
        "typescript/no-empty-object-type": [
          "error",
          { allowInterfaces: "always" },
        ],
      },
    },
    {
      // Intentional synchronous lazy/optional CommonJS requires.
      files: [
        "src/service/core-parts.ts",
        "src/service/routes.ts",
        "src/service/request.ts",
        "src/service/env.ts",
        "src/services/worker/nuq-fdb/client.ts",
        "src/__tests__/snips/utils/collect-mocks.js",
      ],
      rules: {
        "typescript/no-require-imports": "off",
      },
    },
    {
      // CLI harness and test suites write diagnostic output to stdout/stderr.
      files: [
        "src/harness.ts",
        "**/*.{test,spec,integration,e2e}.{ts,tsx,mts,cts}",
        "**/__tests__/**/*.{ts,tsx,mts,cts}",
      ],
      rules: {
        "no-console": "off",
      },
    },
  ],
});
