#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import path from "node:path";
import { evaluateExtraction, readBenchmarkCase, summarize } from "./scorer.mjs";

async function collectCaseFiles(args) {
  if (args.length > 0) return args;

  const fixtureDir = path.join(import.meta.dirname, "fixtures");
  const entries = await readdir(fixtureDir);
  return entries.filter((entry) => entry.endsWith(".json")).map((entry) => path.join(fixtureDir, entry));
}

const files = await collectCaseFiles(process.argv.slice(2));
const results = [];

for (const file of files) {
  const benchmarkCase = await readBenchmarkCase(file);
  results.push(evaluateExtraction(benchmarkCase));
}

const summary = summarize(results);
console.log(JSON.stringify(summary, null, 2));

if (summary.failed > 0) {
  process.exitCode = 1;
}
