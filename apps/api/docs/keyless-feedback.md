# Keyless feedback

Eligible keyless callers submit optional evidence through `POST /v2/feedback`. Search, Scrape, and Parse use the same identity and submission limits across API, MCP, and CLI. An API key is not required. The authenticated feedback routes keep their existing request contracts.

A submission requires `endpoint`, `jobId`, `rating` (`good`, `partial`, or `bad`), `task`, `assessment`, and 1-20 `observations`. Task, assessment, and observation detail must each contain 10-2000 characters after trimming. These bounds reject empty or very short answers; they cannot guarantee factual accuracy.

Each observation requires `kind`, `detail`, and `basis`. Use `output` for observations about returned content, `source_comparison` for comparisons already made, and `expectation` for unmet expectations that have not been verified against a source. A source comparison requires `comparison: {reference, detail}`. Do not guess missing content, diagnose root causes, or investigate solely to submit feedback. Unmentioned results are unassessed.

Search: useful and irrelevant require a one-based position within the delivered group. source names the response group the position refers to: web, images, or news. It is required only when the job requested multiple sources; otherwise it defaults to web. The position must exist in that requested group. irrelevant requires reason: aggregator_over_official, off_topic, stale, wrong_content_type, snippet_misleading, or blocked_or_paywalled. vertical is required on missing and optional on useful/irrelevant: web_general, social, business, research, developer, news, government, finance, or other. missing may include topic (up to 200 characters) and knownSources (up to 20 HTTP(S) URLs). Do not submit engine attribution; it comes from the stored category tag at that position.

Scrape: kind correct, wrong_success, incomplete, or incorrect. wrong_success requires reason: blocked_shell, login_required, paywall, empty, wrong_page, stale, or wrong_locale. incomplete requires reason: partial_content, dynamic_content, pagination, main_content_stripped, or format_lost. incorrect requires reason: wrong, hallucinated, or missing_fields. correct has no reason. Optional location is up to 200 characters. No retryOutcome. Hard-failed Scrape jobs receive no feedback invitation.

Parse: docClass is required once per submission: born_digital, scanned, mixed, or unknown. Observation kind: correct, text_ocr, table, formula, chart_figure, reading_order, headers_footers, headings_formatting, completeness, images_dropped, or incorrect. text_ocr requires reason: misread_chars, garbled, or missing_text. table requires reason: structure, cells_glued, or digits. completeness requires reason: pages_missing, truncated_at_max_pages, or sections_dropped. incorrect requires reason: wrong, hallucinated, or missing_fields. Other kinds have no reason subtype. Optional page is a one-based positive integer.

Scrape and Parse: format must be a format type the job requested. It is required for output and source_comparison observations when multiple formats were requested; optional for expectation observations and single-format jobs. All observations retain detail and basis; source_comparison requires comparison: {reference, detail}.

```json
{
  "endpoint": "search",
  "jobId": "00000000-0000-4000-8000-000000000001",
  "rating": "partial",
  "task": "Find the documented retry behavior",
  "assessment": "The API reference answered the retry question, but the news result did not.",
  "observations": [
    {
      "kind": "useful",
      "source": "web",
      "position": 1,
      "basis": "output",
      "detail": "The reference specifies the retry intervals."
    },
    {
      "kind": "irrelevant",
      "reason": "off_topic",
      "source": "news",
      "position": 1,
      "basis": "output",
      "detail": "The announcement does not discuss retry behavior."
    }
  ]
}
```

## Discovery and clients

Search returns its `id` and optional top-level `metadata`. Scrape and Parse include `jobId` and optional `feedback` in `data.metadata`. Execution failures can include top-level `metadata`. Submit feedback using the job reference returned for the same caller and endpoint.

MCP exposes `firecrawl_feedback`. CLI exposes `firecrawl feedback <endpoint> <jobId> --rating <rating> --task <task> --assessment <assessment> --observations-file <path>`. Parse submissions also require `docClass`, passed as `--doc-class` in CLI. CLI invitations use stderr, preserving ordinary stdout; JSON results retain metadata.

Eligible responses may include an optional invitation to submit feedback. Submissions remain optional and are never required for continued keyless access.

## Submission behavior

One new submission is accepted per keyless identity per UTC day, shared across Search, Scrape, Parse, and all clients. A retry for the same eligible job returns the original feedback ID with `alreadySubmitted: true`. Feedback does not consume or restore operation allowance.

A job may no longer be eligible when feedback is submitted.

Accepted feedback is stored with the originating request options and available result context. Jobs that disallow data retention are excluded.
