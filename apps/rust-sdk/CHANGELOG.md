## CHANGELOG

## [2.17.0] - 2026-08-26

### Added

- Added `AgentOptions::effort` (`AgentEffort`) for the agent reasoning budget,
  and `AgentStatusResponse::effort` for the effort a run used.
- Added `Client::get_agent_trace` returning the job's execution trace as typed
  `AgentTraceEvent`s (canonical event schema v1), with optional live-view
  browser sessions.
- Added `Client::get_agent_snapshot` returning the full content of an artifact
  snapshot referenced by an `artifact.updated` trace event.

## [2.16.1] - 2026-08-26

### Fixed

- Agent, crawl, batch scrape, map, and parse requests now send
  `origin: "rust-sdk@<version>"` for request attribution, matching the other
  SDKs. Agent requests previously sent no origin at all, which made them
  indistinguishable from raw API traffic server-side. A caller-provided
  `origin` is still respected.

## [2.16.0] - 2026-08-21

### Added

- Added `ParserConfig::Pdf.page_markers` to join PDF pages in
  `document.markdown` with `\n\n---\n\n<!-- page N -->\n\n`.

## [2.15.0] - 2026-08-21

### Added

- Added `AgentModel::Spark2` for the `spark-2` agent model, now the server-side
  default. Agent status responses for jobs running it previously failed to
  deserialize.
- Added `AgentModel::Unknown`, a `#[serde(other)]` catch-all so an agent status
  response naming a model this release predates degrades to `Unknown` instead
  of failing the parse and breaking the status wait loop. Read-only: it
  serializes to `"unknown"`, which the API rejects.

## [2.14.0] - 2026-08-19

### Added

- Added `ParserConfig::Pdf.pages` to request per-page PDF markdown.
- Added `Document.pages` (`PdfPage`) for physical page markdown.

## [2.13.0] - 2026-08-19

### Added

- Added `ParserConfig::Pdf.blocks` to request typed PDF layout blocks.
- Added `Document.blocks` (`PdfPageBlocks`) for per-page bounding boxes, block types, and reading order.

## [2.5.0] - 2026-05-12

### Added

- Added `Format::Video` and `Document.video` support for video extraction results.

## [0.1]

### Added

- [feat] Firecrawl rust sdk.
