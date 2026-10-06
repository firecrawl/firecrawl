## CHANGELOG

## [2.21.3] - 2026-10-06

### Added

- Added `AgentOptions::exchange` (`AgentExchangeOptions`) so agent runs can use
  the team's Exchange (Alexandria) data providers, including `approve` and
  `decline` answers to a pending approval. Added `AgentOptions::thread_id` and
  `AgentOptions::mode` (`AgentMode`) to continue a thread and run in chat mode.
- `AgentResponse` now carries `thread_id` and `thread_turn`.
  `AgentStatusResponse` now carries `thread_id`, `thread_turn`, `mode`,
  `message`, `pending_approval` (`AgentPendingApproval`), and `exchange`
  (`AgentExchangeSummary`).

## [2.21.2] - 2026-10-02

### Added

- Added `Client::get_parse_formats` for `GET /v2/parse/formats`, returning the
  upload formats `parse` accepts as `ParseFormatInfo` entries (`format`,
  `kind`, `extensions`, `mime_types`, `available`). `ParseFormatKind` falls
  back to `Unknown` for kinds this release does not know about.

## [2.21.1] - 2026-09-30

### Security

- Pagination `next` URLs followed by `get_crawl_status`,
  `get_batch_scrape_status`, and `get_monitor_check` are now pinned to the
  configured API origin, so the API key is never sent to another host.

## [2.19.0] - 2026-09-08

### Added

- Added `SearchOptions::country` to geo-target a v2 search. The field
  is omitted when the caller does not set it.

## [2.18.0] - 2026-08-31

### Added

- Added `Client::list_agents` returning a page of the team's agent runs
  (most recent first) with an optional `before` cursor. The method does not
  auto-paginate; pass the `before` value from the response's `next` URL to
  fetch the next page.

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
