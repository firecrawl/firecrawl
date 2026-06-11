import { readFile } from "node:fs/promises";

const DEFAULT_WEIGHTS = {
  requiredFields: 0.25,
  expectedValues: 0.25,
  tableCoverage: 0.2,
  sectionCoverage: 0.15,
  markdownPreservation: 0.15,
};

export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value) {
  return new Set(normalizeText(value).split(/\s+/).filter(Boolean));
}

export function tokenSimilarity(left, right) {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

export function getPath(value, path) {
  return String(path)
    .split(".")
    .filter(Boolean)
    .reduce((current, part) => {
      if (current === null || current === undefined) return undefined;
      if (Array.isArray(current) && /^\d+$/.test(part)) return current[Number(part)];
      return current[part];
    }, value);
}

function hasUsableValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function ratio(numerator, denominator) {
  if (denominator === 0) return 1;
  return Math.max(0, Math.min(1, numerator / denominator));
}

function numericCount(value) {
  if (Array.isArray(value)) return value.length;
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function scoreRequiredFields(actual, requiredFields = []) {
  const missing = [];
  let present = 0;

  for (const field of requiredFields) {
    if (hasUsableValue(getPath(actual, field))) {
      present += 1;
    } else {
      missing.push(field);
    }
  }

  return {
    score: ratio(present, requiredFields.length),
    present,
    total: requiredFields.length,
    missing,
  };
}

export function scoreExpectedValues(actual, expectedValues = []) {
  const details = [];
  let total = 0;

  for (const expectation of expectedValues) {
    const actualValue = getPath(actual, expectation.path);
    const expectedValue = expectation.value;
    const threshold = expectation.threshold ?? 0.72;
    const similarity = tokenSimilarity(actualValue, expectedValue);
    const passed = similarity >= threshold;
    total += passed ? 1 : similarity;
    details.push({
      path: expectation.path,
      expected: expectedValue,
      actual: actualValue,
      similarity,
      threshold,
      passed,
    });
  }

  return {
    score: ratio(total, expectedValues.length),
    details,
  };
}

export function scoreTableCoverage(actual, expectedTables = []) {
  const details = [];
  let total = 0;

  for (const table of expectedTables) {
    const actualRows = getPath(actual, table.path);
    const rowCount = numericCount(actualRows);
    const requiredRows = table.minRows ?? table.rows ?? 1;
    const rowScore = ratio(rowCount, requiredRows);

    const requiredColumns = table.requiredColumns ?? [];
    let columnScore = 1;
    const missingColumns = [];
    if (requiredColumns.length > 0 && Array.isArray(actualRows) && actualRows.length > 0) {
      const seenColumns = new Set(actualRows.flatMap((row) => Object.keys(row ?? {})));
      for (const column of requiredColumns) {
        if (!seenColumns.has(column)) missingColumns.push(column);
      }
      columnScore = ratio(requiredColumns.length - missingColumns.length, requiredColumns.length);
    } else if (requiredColumns.length > 0) {
      columnScore = 0;
      missingColumns.push(...requiredColumns);
    }

    const score = rowScore * 0.7 + columnScore * 0.3;
    total += score;
    details.push({
      path: table.path,
      rowCount,
      requiredRows,
      requiredColumns,
      missingColumns,
      score,
    });
  }

  return {
    score: ratio(total, expectedTables.length),
    details,
  };
}

export function scoreSectionCoverage(markdown = "", expectedSections = []) {
  const normalizedMarkdown = normalizeText(markdown);
  const details = expectedSections.map((section) => {
    const found = normalizedMarkdown.includes(normalizeText(section));
    return { section, found };
  });

  return {
    score: ratio(details.filter((detail) => detail.found).length, expectedSections.length),
    details,
  };
}

export function scoreMarkdownPreservation(markdown = "", expectations = {}) {
  const checks = [
    {
      name: "codeBlocks",
      expected: Boolean(expectations.codeBlocks),
      found: /```|<code[\s>]/i.test(markdown),
    },
    {
      name: "links",
      expected: Boolean(expectations.links),
      found: /\[[^\]]+\]\([^)]+\)|<a\s/i.test(markdown),
    },
    {
      name: "headings",
      expected: Boolean(expectations.headings),
      found: /^#{1,6}\s+\S/m.test(markdown),
    },
    {
      name: "lists",
      expected: Boolean(expectations.lists),
      found: /^(\s*[-*+]\s+|\s*\d+\.\s+)/m.test(markdown),
    },
  ].filter((check) => check.expected);

  return {
    score: ratio(checks.filter((check) => check.found).length, checks.length),
    details: checks,
  };
}

export function evaluateExtraction(caseDefinition) {
  const {
    name,
    url,
    actual = {},
    expected = {},
    markdown = actual.markdown ?? "",
    weights = DEFAULT_WEIGHTS,
  } = caseDefinition;

  const metrics = {
    requiredFields: scoreRequiredFields(actual, expected.requiredFields ?? []),
    expectedValues: scoreExpectedValues(actual, expected.values ?? []),
    tableCoverage: scoreTableCoverage(actual, expected.tables ?? []),
    sectionCoverage: scoreSectionCoverage(markdown, expected.sections ?? []),
    markdownPreservation: scoreMarkdownPreservation(markdown, expected.markdown ?? {}),
  };

  const score = Object.entries(weights).reduce((total, [metric, weight]) => {
    return total + (metrics[metric]?.score ?? 0) * weight;
  }, 0);

  const failures = [];
  for (const field of metrics.requiredFields.missing) {
    failures.push({ metric: "requiredFields", message: `missing required field: ${field}` });
  }
  for (const detail of metrics.expectedValues.details) {
    if (!detail.passed) {
      failures.push({ metric: "expectedValues", message: `low similarity at ${detail.path}: ${detail.similarity.toFixed(2)}` });
    }
  }
  for (const detail of metrics.tableCoverage.details) {
    if (detail.score < 1) {
      failures.push({ metric: "tableCoverage", message: `table coverage gap at ${detail.path}: ${detail.score.toFixed(2)}` });
    }
  }
  for (const detail of metrics.sectionCoverage.details) {
    if (!detail.found) failures.push({ metric: "sectionCoverage", message: `missing section evidence: ${detail.section}` });
  }
  for (const detail of metrics.markdownPreservation.details) {
    if (!detail.found) failures.push({ metric: "markdownPreservation", message: `markdown did not preserve ${detail.name}` });
  }

  return {
    name,
    url,
    score,
    passed: score >= (expected.minScore ?? 0.85),
    minScore: expected.minScore ?? 0.85,
    metrics,
    failures,
  };
}

export async function readBenchmarkCase(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function summarize(results) {
  const average = results.reduce((total, result) => total + result.score, 0) / Math.max(results.length, 1);
  const failedByMetric = {};
  for (const result of results) {
    for (const failure of result.failures ?? []) {
      failedByMetric[failure.metric] = (failedByMetric[failure.metric] ?? 0) + 1;
    }
  }

  return {
    cases: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    averageScore: Math.round(average * 10000) / 10000,
    failedByMetric,
    results,
  };
}

export function compareToBaseline(summary, baseline, maxScoreDrop = 0.02) {
  if (!baseline) return [];

  const baselineByName = new Map((baseline.results ?? []).map((result) => [result.name, result]));
  const regressions = [];
  for (const result of summary.results) {
    const previous = baselineByName.get(result.name);
    if (!previous) continue;

    const scoreDrop = Number((previous.score - result.score).toFixed(4));
    if (scoreDrop > maxScoreDrop) {
      regressions.push({
        name: result.name,
        previousScore: previous.score,
        currentScore: result.score,
        scoreDrop,
        maxScoreDrop,
      });
    }
  }

  return regressions;
}

export function applyGates(summary, gates = {}, regressions = []) {
  const failures = [];
  const minAverageScore = gates.minAverageScore ?? 0;
  const maxFailedCases = gates.maxFailedCases ?? 0;

  if (summary.averageScore < minAverageScore) {
    failures.push(`average score ${summary.averageScore.toFixed(4)} is below ${minAverageScore.toFixed(4)}`);
  }
  if (summary.failed > maxFailedCases) {
    failures.push(`failed cases ${summary.failed} is above ${maxFailedCases}`);
  }
  for (const regression of regressions) {
    failures.push(
      `${regression.name} score dropped ${regression.scoreDrop.toFixed(4)} from baseline, max allowed ${regression.maxScoreDrop.toFixed(4)}`,
    );
  }

  return failures;
}
