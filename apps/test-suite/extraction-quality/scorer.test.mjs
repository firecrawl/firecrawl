import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyGates,
  compareToBaseline,
  evaluateExtraction,
  getPath,
  scoreExpectedValues,
  scoreRequiredFields,
  scoreTableCoverage,
  summarize,
  tokenSimilarity,
} from "./scorer.mjs";

test("getPath reads nested objects and arrays", () => {
  const actual = { jobs: [{ title: "Search Engineer" }], company: { name: "Firecrawl" } };

  assert.equal(getPath(actual, "jobs.0.title"), "Search Engineer");
  assert.equal(getPath(actual, "company.name"), "Firecrawl");
  assert.equal(getPath(actual, "missing.path"), undefined);
});

test("field coverage catches missing structured fields", () => {
  const score = scoreRequiredFields(
    { company: { name: "Firecrawl" }, jobs: [{ title: "Research Engineer" }] },
    ["company.name", "jobs.0.title", "jobs.0.location"],
  );

  assert.equal(score.present, 2);
  assert.equal(score.total, 3);
  assert.deepEqual(score.missing, ["jobs.0.location"]);
  assert.equal(score.score, 2 / 3);
});

test("expected values use token similarity instead of exact string equality", () => {
  const score = scoreExpectedValues(
    { role: "Research Engineer for search and information retrieval" },
    [{ path: "role", value: "Search/IR Research Engineer", threshold: 0.3 }],
  );

  assert.ok(tokenSimilarity("Search/IR Research Engineer", "Research Engineer for search") > 0.3);
  assert.equal(score.details[0].passed, true);
});

test("evaluateExtraction combines schema, value, table, section, and markdown checks", () => {
  const result = evaluateExtraction({
    name: "careers extraction",
    url: "https://example.com/careers",
    actual: {
      company: { name: "Firecrawl" },
      jobs: [
        { title: "Research Engineer", team: "Search", location: "San Francisco" },
        { title: "Web Automation Engineer", team: "Browser", location: "Remote" },
      ],
      markdown: "# Careers\n\n- Research Engineer\n- Web Automation Engineer\n\n```ts\ncrawl(url)\n```",
    },
    expected: {
      minScore: 0.9,
      requiredFields: ["company.name", "jobs.0.title", "jobs.1.title"],
      values: [{ path: "jobs.0.title", value: "Research Engineer", threshold: 0.8 }],
      tables: [{ path: "jobs", minRows: 2, requiredColumns: ["title", "team", "location"] }],
      sections: ["Careers", "Research Engineer"],
      markdown: { headings: true, lists: true, codeBlocks: true },
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.metrics.tableCoverage.details[0].missingColumns.length, 0);
});

test("table coverage treats non-numeric row counts as zero", () => {
  const score = scoreTableCoverage(
    { jobs: { rows: "unknown" }, links: "not-a-number" },
    [
      { path: "jobs", minRows: 2, requiredColumns: ["title"] },
      { path: "links", minRows: 1 },
    ],
  );

  assert.equal(Number.isNaN(score.score), false);
  assert.equal(score.details[0].rowCount, 0);
  assert.equal(score.details[1].rowCount, 0);
});

test("summarize reports aggregate pass and fail counts", () => {
  const summary = summarize([
    { score: 0.91, passed: true, failures: [] },
    {
      score: 0.7,
      passed: false,
      failures: [{ metric: "requiredFields", message: "missing required field: jobs.0.title" }],
    },
  ]);

  assert.equal(summary.cases, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.averageScore, 0.805);
  assert.deepEqual(summary.failedByMetric, { requiredFields: 1 });
});

test("baseline comparison reports score drops over threshold", () => {
  const current = summarize([{ name: "pricing", score: 0.86, passed: true, failures: [] }]);
  const baseline = summarize([{ name: "pricing", score: 0.93, passed: true, failures: [] }]);

  const regressions = compareToBaseline(current, baseline, 0.02);

  assert.deepEqual(regressions, [
    {
      name: "pricing",
      previousScore: 0.93,
      currentScore: 0.86,
      scoreDrop: 0.07,
      maxScoreDrop: 0.02,
    },
  ]);
});

test("quality gates combine average score, failed cases, and baseline regressions", () => {
  const summary = {
    averageScore: 0.82,
    failed: 2,
  };
  const failures = applyGates(
    summary,
    {
      minAverageScore: 0.9,
      maxFailedCases: 0,
    },
    [
      {
        name: "docs",
        scoreDrop: 0.04,
        maxScoreDrop: 0.02,
      },
    ],
  );

  assert.deepEqual(failures, [
    "average score 0.8200 is below 0.9000",
    "failed cases 2 is above 0",
    "docs score dropped 0.0400 from baseline, max allowed 0.0200",
  ]);
});
