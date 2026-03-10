#!/usr/bin/env node
// Outputs the branding script to stdout for pasting into browser console
// Usage: node print-script.js | pbcopy
const esbuild = require("esbuild");
const path = require("path");

const entryPoint = path.join(__dirname, "index.ts");

const result = esbuild.buildSync({
  entryPoints: [entryPoint],
  bundle: true,
  minify: false, // Don't minify for readability when debugging
  format: "iife",
  globalName: "__extractBrandDesign",
  target: ["es2020"],
  write: false,
});

const bundledCode = result.outputFiles[0].text;

// Wrap in a self-executing function that returns the result
const script = `(function __extractBrandDesign() {
${bundledCode}
return __extractBrandDesign.extractBrandDesign();
})();`;

process.stdout.write(script);
