# Firecrawl v2.12.0

## Improvements

- **Alexandria provider tools** — Discover and execute third-party provider tools directly through Firecrawl. `POST /v2/search` with `sources: ["alexandria"]` returns tool contracts in `data.tools`, `POST /v2/scrape` with `domainTools: true` attaches tools matched to the scraped page's domain, and `POST /v2/scrape` with an `alexandria` body executes one to ten provider calls and returns results in `data.alexandria[]`. Discovery is free; execution bills through the standard rails with idempotent replays keyed on `x-request-id`. Available in the JavaScript, Python, Go, and Rust SDKs.
- **Safe Mode** — Added an organization-level Safe Mode enforced across `/scrape`, `/crawl`, `/batch/scrape`, `/search`, `/map`, `/extract`, `/interact`, and `/monitor`. Blocked options return `403 SAFE_MODE_BLOCKED`, restricted sites return `SCRAPE_SITE_RESTRICTION_BLOCKED`, and `lockdown: true` runs cache-only with no robots, sitemap, or live discovery and zero data retention by default. Includes worker-side backstops that strip profiles, login actions, credential headers, and URL-embedded Basic Auth.
- **`menu` scrape format** — Added a deterministic structured `menu` format that returns restaurant menu data on `document.menu`. Available in all 9 SDKs and gated behind the `menuBeta` team flag; requests without the flag succeed silently with no `menu` field.
- **Interact Session Replay** — Added HLS-based session replay for `/v2/interact` and `/v2/browser` sessions. `GET /v2/interact/:sessionId/replay` lists recorded tabs and `GET /v2/interact/:sessionId/replay/:pageId` returns an `.m3u8` playlist with pre-signed segments (~6h expiry). Session creation accepts `recordSession` (default `true`), and interact responses now include `sessionId` for linking.
- **Threat Protection** — Added an enterprise `threatProtection` policy (`disabled` / `allowed` / `forced`, modes `off` / `normal` / `zscaler`) that classifies scrape, crawl, search, map, extract, and agent URLs through Google Web Risk or a Zscaler ZIA provider. Unsafe pages are blocked with a consistent 4xx and billing dedupes per canonical URL at `+2` credits per scanned URL.
- **IP Restriction** — Added a per-team API key IP allowlist (IPv4, IPv6, CIDR) gated by the `ipRestriction` team flag. Enforced in authentication for API-key and `fco_` OAuth tokens using `req.ip`; unlisted IPs return `403`, with a 60-second Redis cache on the allowlist.
- **API key scope lockdown** — Added a `keyRestriction` team flag that locks individual API keys to allowlists of output formats and endpoint groups (`scrape`, `crawl`, `search`, `agent`, `parse`, …). Enforcement is server-side with no request-side override, unknown paths fail closed, and `screenshot` / `pdf` / `scrape` / `executeJavascript` actions are gated by their corresponding format allowlist.
- **SIEM Logging** — Added organization-scoped SIEM Logging that delivers scrape activity events to third-party destinations through a shared, replica-safe BullMQ queue with retries, stalled-job recovery, and per-delivery credential reloads. Includes a Microsoft Sentinel artifact under `apps/siem/azure-sentinel`.
- **Agent list endpoint** — Added a scalable `GET /v2/agent` with `before` cursor pagination, a `next` URL only when more pages exist, and hidden/starred/labeled run metadata scoped to the authenticated team. Each item now also carries `options.threadId` and `options.threadTurn` so threads can be reconstructed. Added `listAgents` / `list_agents` methods to the JavaScript, Python, Go, Rust, Java, .NET, PHP, Ruby, and Elixir SDKs.
- **Agent `effort` parameter** — Added `effort: "low" | "medium" | "high"` to `POST /v2/agent`, mutually exclusive with `model`. `effort` alone runs against `spark-2` at the requested reasoning budget; the value is echoed on the status response. Available in every agent-supporting SDK.
- **Agent traces and snapshots in SDKs** — Added `getAgentTrace(jobId, liveView?)` (`GET /v2/agent/:id/trace`) and `getAgentSnapshot(jobId, snapshotId)` (`GET /v2/agent/:id/snapshots/:snapshotId`) across the JavaScript, Python, Rust, Go, Java, PHP, Ruby, and Elixir SDKs.
- **Auto-resume for large-document scrapes** — The JavaScript and Python SDKs now transparently resume `/scrape` calls when the API returns `details.state: "processing_continues"`, honoring the payload's `retryAfterSeconds` (clamped 5s–10m) with a bound of 5 resumes and 20 minutes of total wait. Opt out with `autoResume: false` (JS) or `auto_resume=False` (Python).
- **Prompt-injection guard for JSON extraction** — Added an opt-in `checkPromptInjection` boolean to v1 `jsonOptions` / `extract` and v2 `formats: [{ type: "json", … }]`. When enabled, a dedicated classifier scans scraped content before the extraction call and fails fast with `SCRAPE_PROMPT_INJECTION_DETECTED` (`403`) on detection. Adds `+4` credits when the check runs cleanly.
- **PDF page attribution** — Added `parsers[{ type: "pdf", pageMarkers: true }]` to inline per-page markers directly in `document.markdown`, plus `parsers[].pages` for a per-page markdown array and `parsers[].blocks` for typed PDF layout blocks. Renamed the earlier `pageMarkdown` option to `pages`.
- **Image OCR** — Added default image OCR through FirePDF for raster PNG, JPEG, WebP, AVIF, and JPEG 2000 inputs; images route through the image parser and return a one-page document. Rolled out per deployment via `IMAGE_OCR_ENABLED`.
- **Legacy `.doc` formatting** — Improved MS-DOC parsing to preserve inline styles (bold, italic, strikethrough), headings from outline levels, hyperlinks, and tables instead of returning flat text.
- **`anydoc` document parser** — Replaced the custom document parser with `anydoc`, a Rust-based engine that standardizes DOCX, DOC, ODT, RTF, XLSX, XLS, and HTML inputs to Markdown across the parse and scrape paths. Adds byte-level format detection with an extension fallback.
- **Browser profile listing** — Persistent browser profiles created through the API, CLI, or MCP now show up in the dashboard. The API records each session's profile name and upserts `browser_profiles` rows when the browser service reports `profile.saved`. Also added `DELETE /v2/browser/profiles/:name` (and `/v2/interact/profiles/:name`) to delete a profile's saved state and its listing row.
- **`safe` search parameter** — Added an optional `safe: true` on `POST /v2/search` that filters explicit content upstream. Omitted requests are unchanged.
- **`rawBase64` scrape format** — Added `rawBase64` to v2 scrape formats, returning the raw response payload as a base64 string alongside the other document fields.
- **Developer / Code Search out of beta** — Removed the `developerBeta` entitlement gate so `POST /v2/search` accepts the `developer` category and `POST /v2/developer/search` works for every team. Aliases for the `developer` category (e.g. `code`) are accepted on input.
- **PHP SDK Laravel AI tools** — Added a Laravel AI SDK tool base class plus `FirecrawlScrape`, `FirecrawlSearch`, `FirecrawlCrawl`, `FirecrawlMap`, and a `FirecrawlTools::all()` helper. Output size, deadline, and crawl-wait budgets are bounded so long-running jobs stay queue-friendly.
- **JS SDK `webhook` on extract** — Added a `webhook` option to `startExtract()` and `extract()` on the JavaScript SDK, matching the other job-starting methods.
- **Larger crawl path filters** — Raised the `includePaths` / `excludePaths` cap on `POST /v2/crawl` and `POST /v1/crawl` from 100 patterns to 1000, with the compilation cost of each set bounded.

## Fixes

- Resolved multiple CVEs across the API, SDKs, and self-host images including `postcss-selector-parser`, `systeminformation`, `sharp`, `fflate`, `js-yaml`, `tinyvec`, `axios`, and other transitive dependencies through repeated `pnpm audit` sweeps.
- Fixed the prompt-injection guard billing customers when a classifier chunk failed open — unscanned chunks now record a `"none"` verdict, the guard fee only bills when every chunk has a verdict, and the response `warning` surfaces incomplete scans.
- Fixed `GET /v2/agent` returning stale `options` payloads that dropped `threadId` and `threadTurn`, so threaded runs can be grouped in the dashboard sidebar.
- Fixed enhanced-proxy scrapes being surcharged `+4` credits when no proxy egress actually occurred.
- Fixed billing dropping the Lockdown surcharge on `json`-format scrapes.
- Fixed scrapes that fail DNS resolution being billed.
- Fixed screenshot signed URLs returning stale results from cache after key rotation by forcing a re-sign when the signed URL expires.
- Fixed `/map` dropping the first URL of each sitemap and starving sitemap-index children of the fetch budget.
- Fixed `/search` `includeDomains` double-parenthesizing `site:` expressions upstream and failing to pass domain filters through to the search engine.
- Fixed lazy-loaded images not resolving from `data-srcset` and `data-src` attributes.
- Fixed `text/plain` markdown output escaping underscores.
- Fixed JSON-format extraction silently dropping keys — extraction failures now surface as errors instead of quietly returning partial results.
- Fixed empty FirePDF results being served and stored for raster images, and PDFs under 4 KiB now fall back to `pdf-parse` instead of returning nothing.
- Fixed mislabeled PDF and Office downloads by routing them through their magic bytes on the `POST /scrape` fast path.
- Fixed `SCRAPE_ACTIONS_NOT_SUPPORTED` being thrown after a document or PDF prefetch when actions should have been skipped.
- Fixed DOCX parse output dropping headers and footers.
- Fixed monitor webhooks being finalized twice for the same check.
- Fixed `POST /v2/crawl` following external-link redirects onto subdomains within their own domain instead of terminating the crawl.
- Fixed `POST /v1/status/:jobId` and related endpoints returning `500` on non-UUID job IDs — now returns a proper `400`.
- Fixed a stack overflow in native PDF extraction by running it off the Node.js event loop with a bounded concurrency semaphore.
- Fixed per-key spend limits returning `500` on denial — now returns `402` with a clear message.
- Fixed HTML transformations being applied to sitemap XML.
- Fixed keyless authentication errors to point at signup and the `Bearer` scheme.
- Fixed `Rust SDK` failing to parse crawl and batch scrape status responses with negative `creditsUsed`; unknown agent models now degrade instead of aborting the parse.

## API

- Added the `alexandria` source and `domainTools` to `POST /v2/search` and `POST /v2/scrape`. Discovery returns tool contracts in `data.tools` and is free. Execution takes an `alexandria` body of one to ten calls on `POST /v2/scrape`, returns `data.alexandria[]`, `data.creditsCost`, and `scrape_id`, and uses `x-request-id` as its idempotency key. A `403 THIRD_PARTY_DATA_TERMS_REQUIRED` exposes `requiresAction` with the terms URL and version.
- Added `menu` to v1 and v2 scrape formats and populated `document.menu` when the scrape succeeds; requires the `menuBeta` team flag.
- Added `safe: boolean` to `POST /v2/search`. Non-boolean values are rejected with a schema error.
- Added `safeModeConfig` and org-level Safe Mode enforcement. Requests that touch blocked capabilities return `403 SAFE_MODE_BLOCKED`; restricted sites terminate with `SCRAPE_SITE_RESTRICTION_BLOCKED`. Per-request bypass requires `allowBypassSafeMode`.
- Added `threatProtection` team flag with modes `off`, `normal`, and `zscaler`. Enforced across `/scrape`, `/batch/scrape`, `/crawl`, `/search`, `/map`, `/extract`, and `/agent` (v1 + v2). Billing: `+2` credits per unique scanned canonical URL per billing scope. JavaScript and Python SDKs expose the full `threatProtection.mode` enum, including `manual-only` and `zscaler`.
- Added the `ipRestriction` team flag and `ip_restriction_config` allowlist. Unlisted IPs from API-key or `fco_` OAuth tokens are rejected with `403`; empty lists remain unrestricted so teams cannot lock themselves out before configuring.
- Added the `keyRestriction` team flag and `key_restriction_config` per-key allowlists for `allowed_formats` and `allowed_endpoints`. Unknown endpoints and legacy `/v0` endpoints fail closed for restricted keys.
- Added `POST /v2/interact/:sessionId/replay` and `POST /v2/interact/:sessionId/replay/:pageId` (also under `/v2/browser/...`), returning HLS `.m3u8` playlists with pre-signed segments. `POST /v2/interact` accepts `recordSession` (default `true`); `scrape-interact` responses now include `sessionId`.
- Added `DELETE /v2/browser/profiles/:name` and `DELETE /v2/interact/profiles/:name`. Deleting a profile with no saved state succeeds; a session actively saving to the profile returns `409`.
- Added `GET /v2/agent` cursor-paginated list. Accepts `before`; returns 20 runs per page with a `next` URL only when more pages exist. Malformed `before` values are rejected with `400`. Available on every agent-supporting SDK as `listAgents` / `list_agents`.
- Added `effort: "low" | "medium" | "high"` on `POST /v2/agent`. `effort` and `model` together return `400`; `effort` alone runs `spark-2`; `model` alone keeps the requested preset. The `GET /v2/agent/:id` status response includes an optional `effort` field.
- Added `GET /v2/agent/:id/trace` (with `liveView`) and `GET /v2/agent/:id/snapshots/:snapshotId`. All 13 public trace event types are versioned against the agent service's canonical event schema v1.
- Added `checkPromptInjection: boolean` to JSON-mode extraction on v1 `jsonOptions` / `extract` and v2 `formats: [{ type: "json" }]`. Errors with `SCRAPE_PROMPT_INJECTION_DETECTED` (`403`) on detection; billing adds `+4` credits when the check runs cleanly and does not bill when the guard fails open.
- Added `parsers[].pageMarkers`, `parsers[].pages`, and `parsers[].blocks` on the PDF parser. Renamed the earlier `parsers[].pageMarkdown` to `pages` (transformation alias kept for compatibility). `parsers[].totalPages` is now reported on truncated PDFs.
- Added `rawBase64` to v2 scrape formats.
- Added `country` on `POST /v2/search` across the JavaScript, Python, Go, Rust, Ruby, Java, and PHP SDKs.
- Removed the `developerBeta` entitlement gate. `POST /v2/search` now accepts the `developer` category for every team, `POST /v2/developer/search` works without a flag, and the deprecated `POST /v2/search/developer/search` double form has been removed.
- Allowed `screenshot` and `pdf` action variants on Zero-Data-Retention scrapes.
- Raised the `includePaths` / `excludePaths` cap on `POST /v2/crawl` and `POST /v1/crawl` from 100 to 1000 patterns; regexes the engine cannot honor are now rejected up front.
- Changed the per-key spend-limit denial to return `402` (previously surfaced as a `500`).

---

**Full Changelog**: https://github.com/firecrawl/firecrawl/compare/v2.11.0...v2.12.0
