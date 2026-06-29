// Builds the in-page menu-modifier capture script (run as an executeJavascript action when the
// `menu` format has `modifiers: true`). Mirrors brandingScript.ts: the logic lives as TypeScript in
// ./menu-modifier-script and is bundled at runtime with esbuild, then wrapped in a self-executing
// function that returns the capture promise (fire-engine awaits it). See ./menu-modifier-script for
// the capture strategy and design rationale.
import path from "path";
import fs from "fs";

let cachedScript: string | null = null;

export const getMenuModifierScript = (): string => {
  if (cachedScript) {
    return cachedScript;
  }

  // Development: use the .ts source directly. Production (Docker): the compiled .js in dist/.
  let entryPoint = path.join(__dirname, "menu-modifier-script", "index.ts");
  if (!fs.existsSync(entryPoint)) {
    entryPoint = path.join(__dirname, "menu-modifier-script", "index.js");
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const esbuild = require("esbuild");

  const result = esbuild.buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "__menuModifiers",
    target: ["es2020"],
    write: false,
  });

  const bundledCode = result.outputFiles[0].text;

  // Self-executing wrapper that returns the capture promise. `captureMenuModifiers` is async, so the
  // wrapper returns a Promise that the fire-engine JS action awaits before reporting the result.
  cachedScript = `(function __menuModifiers() {
${bundledCode}
return __menuModifiers.captureMenuModifiers();
})();`;

  return cachedScript;
};
