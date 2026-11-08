import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: false,
  outputOptions: { banner: "#!/usr/bin/env node" },
});
