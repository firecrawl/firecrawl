const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const knipPackagePath = require.resolve("knip/package.json");
const knipNodeModules = path.dirname(path.dirname(knipPackagePath));
const knipTypescriptPath = path.join(knipNodeModules, "typescript");
const typescript5Path = path.dirname(require.resolve("typescript5/package.json"));

let originalTarget;
let hadOriginal = false;

try {
  hadOriginal = fs.existsSync(knipTypescriptPath);
  if (hadOriginal) {
    originalTarget = fs.readlinkSync(knipTypescriptPath);
    fs.unlinkSync(knipTypescriptPath);
  }

  fs.symlinkSync(typescript5Path, knipTypescriptPath, "dir");

  const result = spawnSync(
    process.execPath,
    [require.resolve("knip/bin/knip.js"), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );

  process.exitCode = result.status ?? 1;
} finally {
  try {
    if (fs.existsSync(knipTypescriptPath)) {
      fs.unlinkSync(knipTypescriptPath);
    }
    if (hadOriginal) {
      fs.symlinkSync(originalTarget, knipTypescriptPath, "dir");
    }
  } catch (error) {
    console.error("Failed to restore knip TypeScript peer link:", error);
    process.exitCode = process.exitCode || 1;
  }
}
