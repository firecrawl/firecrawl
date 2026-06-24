import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // pdf-parse's package entry runs a debug self-test (reading a sample PDF)
      // when `module.parent` is falsy, which it is under Vitest's runner. Point
      // at the real implementation entry to skip that wrapper. Test-only.
      { find: /^pdf-parse$/, replacement: "pdf-parse/lib/pdf-parse.js" },
    ],
  },
  test: {
    environment: "node",
    // describe/it/expect/vi available without imports (most test files rely on this).
    globals: true,
    // 136 .test.ts files, both colocated (src/**/*.test.ts) and under src/__tests__/.
    include: ["src/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    // snips use a 90s scrapeTimeout constant; give per-test/hook headroom.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Real servers/sockets need a moment to drain (was Jest's openHandlesTimeout).
    teardownTimeout: 30_000,
    // junit is built-in; same output path the CI Python parser reads.
    reporters: ["default", "junit"],
    outputFile: { junit: "./test-results/junit.xml" },
    server: {
      deps: {
        // langsmith is pulled in via lazy require() in scrape-interact/langsmith.ts;
        // inlining it routes that require through Vitest so vi.mock can intercept.
        inline: [/langsmith/],
      },
    },
    // Defaults pool:"forks" and isolate:true are intentional: this suite talks to
    // real services and does heavy module mocking (vi.resetModules + vi.doMock).
    // The suite manages mock state manually, so clear/reset/restore stay false.
  },
});
