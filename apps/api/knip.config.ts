import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: ["src/services/worker/**/*.ts", "src/services/**/*-worker.ts"],
      project: ["src/**/*.ts"],
    },
  },
  ignore: ["native/**"],
  ignoreDependencies: [
    "openai",
    "undici-types",

    "@sentry/cli", // Used in scripts/upload-sentry-sourcemaps.sh
  ],
};

export default config;
