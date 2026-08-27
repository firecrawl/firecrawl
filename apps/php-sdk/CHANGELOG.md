# Changelog

All notable changes to the Firecrawl PHP SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.14.0] - 2026-08-26

### Added
- Agent `effort` option ("low", "medium", "high") on `AgentOptions` to set the
  reasoning budget (every level runs spark-2), and `AgentStatusResponse::getEffort()`
  exposing the effort a job ran with.
- `getAgentTrace()` returning an `AgentTraceResponse` with typed `AgentTraceEvent`
  models for every trace event kind, plus `activeBrowserSessions` with live view
  URLs when the `liveView` query parameter is requested.
- `getAgentSnapshot()` returning an `AgentSnapshotResponse` with the snapshot
  content of an artifact produced by an agent task.

## [1.13.0] - 2026-08-21

### Added
- PDF parser `pageMarkers` option via `PDFParser` to join pages in
  document markdown with `<!-- page N -->` separators.

## [1.12.0] - 2026-08-19

### Added
- PDF parser `pages` option and `Document::getPages()` for per-page markdown.

## [1.11.0] - 2026-08-19

### Added
- PDF parser `blocks` option and `Document::getBlocks()` for per-page typed
  layout blocks (bounding boxes, block types, reading order).

## [1.9.0] - 2026-07-10

### Added
- Laravel AI SDK integration: native tool classes `FirecrawlScrape`, `FirecrawlSearch`,
  `FirecrawlMap`, and `FirecrawlCrawl` in `Firecrawl\Laravel\Tools`, plus a
  `FirecrawlTools::all()` helper. Drop them into any `laravel/ai` agent's `tools()`
  array; API key and config are reused from the existing Laravel integration.
  Requires `laravel/ai ^0.9` (PHP 8.3+, Laravel 12+) in the consuming app.
- `CrawlOptions::with(idempotencyKey:)`: `startCrawl()` now sends the
  `x-idempotency-key` header, matching the existing batch scrape support.
- `startCrawl()` and `getCrawlStatus()` accept an optional per-request
  timeout in seconds.

### Fixed
- `scrape()`, `search()`, and `map()` now throw `FirecrawlException` when the API
  returns an HTTP 200 response with `success: false` (for example DNS resolution
  failures), instead of silently hydrating an empty result.

## [1.3.0] - 2026-05-12

### Added
- Added `video` scrape format support and `Document::getVideo()` for video extraction results.

## [1.1.0] - 2026-04-21

### Added
- Parse: `parse()` with `ParseFile` and `ParseOptions` models for uploading
  local files (`html`, `pdf`, `docx`, etc.) to the `/v2/parse` endpoint via
  multipart form data.

## [1.0.0] - 2026-04-13

### Added
- Initial release with Firecrawl v2 API support
- Scrape: `scrape()`, `interact()`, `stopInteractiveBrowser()`
- Crawl: `crawl()`, `startCrawl()`, `getCrawlStatus()`, `cancelCrawl()`, `getCrawlErrors()`
- Batch Scrape: `batchScrape()`, `startBatchScrape()`, `getBatchScrapeStatus()`, `cancelBatchScrape()`
- Map: `map()`
- Search: `search()`
- Agent: `agent()`, `startAgent()`, `getAgentStatus()`, `cancelAgent()`
- Browser: `browser()`, `browserExecute()`, `deleteBrowser()`, `listBrowsers()`
- Usage: `getConcurrency()`, `getCreditUsage()`
- Automatic polling with pagination for async jobs (crawl, batch scrape, agent)
- Retry with exponential backoff for transient failures (408, 409, 502, 5xx)
- Typed exception hierarchy: `FirecrawlException`, `AuthenticationException`, `RateLimitException`, `JobTimeoutException`
- Laravel integration: auto-discovered service provider, publishable config, `Firecrawl` facade
- PHP 8.1+ support with named parameters and readonly properties
