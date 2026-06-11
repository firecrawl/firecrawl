import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
    { score: 0.91, passed: true },
    { score: 0.7, passed: false },
  ]);

  assert.equal(summary.cases, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.averageScore, 0.805);
});
