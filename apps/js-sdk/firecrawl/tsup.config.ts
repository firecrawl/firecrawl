import { defineConfig } from "tsup";

export default defineConfig({
  entryPoints: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  outDir: "dist",
  clean: true,
  platform: "node",
  target: "node22",
  esbuildOptions(options) {
    options.define = {
      ...options.define,
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
    };
  },
});