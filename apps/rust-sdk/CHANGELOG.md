## CHANGELOG

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
