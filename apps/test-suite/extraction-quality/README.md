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
node extraction-quality/run-benchmark.mjs
```

You can pass one or more case files to run a focused benchmark:

```bash
node extraction-quality/run-benchmark.mjs extraction-quality/fixtures/careers-page.json
```

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
