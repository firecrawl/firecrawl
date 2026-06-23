// Branding script for extracting brand design tokens from web pages
// Built at runtime using esbuild
import path from "path";
import fs from "fs";

let cachedScript: string | null = null;

export const getBrandingScript = (): string => {
  if (cachedScript) {
    return cachedScript;
  }

  // Determine the correct path to the branding script source files
  // Development: use .ts files directly
  // Production (Docker): use compiled .js files in dist/
  let entryPoint = path.join(__dirname, "branding-script", "index.ts");

  if (!fs.existsSync(entryPoint)) {
    // Fall back to compiled .js files (production Docker)
    entryPoint = path.join(__dirname, "branding-script", "index.js");
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const esbuild = require("esbuild");

  const result = esbuild.buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "__extractBrandDesign",
    target: ["es2020"],
    write: false,
  });

  const bundledCode = result.outputFiles[0].text;

  // Wrap in a self-executing function that returns the result
  cachedScript = `(function __extractBrandDesign() {
${bundledCode}
return __extractBrandDesign.extractBrandDesign();
})();`;

  return cachedScript;
};
