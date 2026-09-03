#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyGates,
  compareToBaseline,
  evaluateExtraction,
  readBenchmarkCase,
  summarize,
} from "./scorer.mjs";

const DEFAULT_FIXTURE_DIR = path.join(import.meta.dirname, "fixtures");

function parseArgs(argv) {
  const args = {
    files: [],
    manifest: null,
    baseline: null,
    outputJson: null,
    outputMarkdown: null,
    maxScoreDrop: 0.02,
    minAverageScore: null,
    maxFailedCases: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = argv[++index];
    else if (arg === "--baseline") args.baseline = argv[++index];
    else if (arg === "--output-json") args.outputJson = argv[++index];
    else if (arg === "--output-markdown") args.outputMarkdown = argv[++index];
    else if (arg === "--max-score-drop") args.maxScoreDrop = Number(argv[++index]);
    else if (arg === "--min-average-score") args.minAverageScore = Number(argv[++index]);
    else if (arg === "--max-failed-cases") args.maxFailedCases = Number(argv[++index]);
    else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    else args.files.push(arg);
  }

  return args;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function collectDefaultCaseFiles() {
  const entries = await readdir(DEFAULT_FIXTURE_DIR);
  return entries.filter((entry) => entry.endsWith(".json")).map((entry) => path.join(DEFAULT_FIXTURE_DIR, entry));
}

async function collectManifestCaseFiles(manifestPath) {
  const manifest = await readJson(manifestPath);
  const manifestDir = path.dirname(manifestPath);
  const suites = manifest.suites ?? [];
  const caseFiles = [];

  for (const suite of suites) {
    for (const caseFile of suite.cases ?? []) {
      caseFiles.push(path.resolve(manifestDir, caseFile));
    }
  }

  return {
    name: manifest.name ?? path.basename(manifestPath),
    caseFiles,
    gates: manifest.gates ?? {},
  };
}

async function collectRunConfig(args) {
  if (args.manifest) return collectManifestCaseFiles(args.manifest);
  if (args.files.length > 0) {
    return {
      name: "custom",
      caseFiles: args.files.map((file) => path.resolve(file)),
      gates: {},
    };
  }
  return {
    name: "default",
    caseFiles: await collectDefaultCaseFiles(),
    gates: {},
  };
}

function resultStatus(result) {
  return result.passed ? "pass" : "fail";
}

function buildMarkdownReport(payload) {
  const lines = [
    "# Extraction Quality Benchmark",
    "",
    `Suite: ${payload.name}`,
    "",
    "| Case | Status | Score | Min score | Failures |",
    "|---|---:|---:|---:|---|",
  ];

  for (const result of payload.summary.results) {
    const failures = (result.failures ?? []).map((failure) => failure.message).join("<br>");
    lines.push(
      `| ${result.name} | ${resultStatus(result)} | ${result.score.toFixed(4)} | ${result.minScore.toFixed(4)} | ${failures || "none"} |`,
    );
  }

  lines.push("", "## Summary", "");
  lines.push(`- Cases: ${payload.summary.cases}`);
  lines.push(`- Passed: ${payload.summary.passed}`);
  lines.push(`- Failed: ${payload.summary.failed}`);
  lines.push(`- Average score: ${payload.summary.averageScore.toFixed(4)}`);

  const failedMetrics = Object.entries(payload.summary.failedByMetric ?? {});
  if (failedMetrics.length > 0) {
    lines.push("", "## Failure taxonomy", "");
    for (const [metric, count] of failedMetrics) {
      lines.push(`- ${metric}: ${count}`);
    }
  }

  if (payload.regressions.length > 0) {
    lines.push("", "## Baseline regressions", "");
    for (const regression of payload.regressions) {
      lines.push(
        `- ${regression.name}: ${regression.previousScore.toFixed(4)} -> ${regression.currentScore.toFixed(4)}`,
      );
    }
  }

  if (payload.gateFailures.length > 0) {
    lines.push("", "## Gate failures", "");
    for (const failure of payload.gateFailures) {
      lines.push(`- ${failure}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function writeArtifact(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

const args = parseArgs(process.argv.slice(2));
const runConfig = await collectRunConfig(args);
const results = [];

if (runConfig.caseFiles.length === 0) {
  throw new Error(`No benchmark cases found for suite "${runConfig.name}"`);
}

for (const file of runConfig.caseFiles) {
  const benchmarkCase = await readBenchmarkCase(file);
  results.push(evaluateExtraction(benchmarkCase));
}

const summary = summarize(results);
const baseline = args.baseline ? await readJson(args.baseline) : null;
const baselineSummary = baseline?.summary ?? baseline;
const regressions = compareToBaseline(summary, baselineSummary, args.maxScoreDrop);
const gates = {
  ...runConfig.gates,
  ...(args.minAverageScore === null ? {} : { minAverageScore: args.minAverageScore }),
  ...(args.maxFailedCases === null ? {} : { maxFailedCases: args.maxFailedCases }),
};
const gateFailures = applyGates(summary, gates, regressions);
const payload = {
  name: runConfig.name,
  generatedAt: new Date().toISOString(),
  caseFiles: runConfig.caseFiles,
  gates,
  regressions,
  gateFailures,
  summary,
};

if (args.outputJson) {
  await writeArtifact(args.outputJson, `${JSON.stringify(payload, null, 2)}\n`);
}
if (args.outputMarkdown) {
  await writeArtifact(args.outputMarkdown, buildMarkdownReport(payload));
}

console.log(JSON.stringify(payload, null, 2));

if (summary.failed > 0 || gateFailures.length > 0) {
  process.exitCode = 1;
}
