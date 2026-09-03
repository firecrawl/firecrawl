# Extraction Quality Benchmark

This benchmark helps score web data extraction results before they are used for RAG ingestion, search indexes, or downstream agents.

It is intentionally independent of Firecrawl internals. A test case gives the benchmark an `actual` extraction result and an `expected` contract. The scorer reports where the extraction failed instead of returning a single opaque pass or fail.

## What It Scores

- Required structured fields such as `company.name` or `jobs.0.title`
- Fuzzy expected values for fields that may be worded slightly differently
- Table or collection coverage, including minimum row counts and required columns
- Markdown section evidence
- Markdown preservation for headings, lists, links, and code blocks

## Run

```bash
cd apps/test-suite
pnpm test:extraction-quality
pnpm benchmark:extraction-quality
```

You can pass one or more case files to run a focused benchmark:

```bash
node extraction-quality/run-benchmark.mjs extraction-quality/fixtures/careers-page.json
```

To run the full manifest without using the package script:

```bash
node extraction-quality/run-benchmark.mjs \
  --manifest extraction-quality/manifest.json \
  --baseline extraction-quality/baselines/current.json \
  --output-json extraction-quality/results/latest.json \
  --output-markdown extraction-quality/results/latest.md
```

The manifest run writes a JSON artifact for CI and a Markdown report for humans. It fails when a case fails its `minScore`, when the suite breaks its gates, or when a case drops more than the allowed score delta from the baseline.

## Regression Gates

`manifest.json` defines suite-level gates:

- `minAverageScore`: minimum average score across all cases
- `maxFailedCases`: maximum number of failed fixtures allowed

The CLI also accepts:

- `--baseline`: previous benchmark summary to compare against
- `--max-score-drop`: maximum allowed per-case score drop before flagging a regression
- `--min-average-score`: override the manifest average score gate
- `--max-failed-cases`: override the manifest failed case gate

This catches subtle regressions where the suite still passes overall but a specific extraction surface gets worse.

## Included Scenarios

- Careers page extraction: structured roles plus markdown evidence
- Pricing table extraction: plan rows, nested feature lists, and preserved links
- API docs extraction: endpoint metadata, parameter tables, links, and code blocks
- Noisy SPA careers extraction: script-heavy markdown with job data and mailto links

## Case Shape

```json
{
  "name": "SPA careers page extraction",
  "url": "https://example.com/careers",
  "actual": {
    "company": { "name": "Example Robotics" },
    "jobs": [{ "title": "Robotics Software Engineer" }],
    "markdown": "# Careers\n\n- Robotics Software Engineer"
  },
  "expected": {
    "minScore": 0.9,
    "requiredFields": ["company.name", "jobs.0.title"],
    "values": [{ "path": "jobs.0.title", "value": "Robotics Software Engineer" }],
    "tables": [{ "path": "jobs", "minRows": 1, "requiredColumns": ["title"] }],
    "sections": ["Careers"],
    "markdown": { "headings": true, "lists": true }
  }
}
```

This gives contributors and maintainers a place to add small, reproducible extraction fixtures when a site shape regresses.
