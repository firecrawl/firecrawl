use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::firepdf::{WirePage, WirePageBlocks};

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PdfMode {
  #[default]
  Auto,

  Fast,
  Ocr,
}

/// One physical page of markdown, as surfaced on `Document.pages`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PdfPage {
  /// 1-based physical page number.
  pub page_number: u32,
  pub markdown: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct PdfBlockItemConfidence {
  pub layout: Option<f64>,
  pub ocr: Option<f64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PdfBlockItem {
  pub id: String,
  pub r#type: String,
  pub label: Option<String>,
  pub bbox: Option<[f64; 4]>,
  pub content: String,
  pub markdown_span: Option<[f64; 2]>,
  pub reading_order: f64,
  pub source: Option<String>,
  pub confidence: PdfBlockItemConfidence,
}

/// Typed layout blocks of one page, as surfaced on `Document.blocks`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageBlocks {
  pub page_number: u32,
  pub width: Option<f64>,
  pub height: Option<f64>,
  pub status: String,
  pub items: Vec<PdfBlockItem>,
}

impl From<WirePage> for PdfPage {
  fn from(page: WirePage) -> Self {
    Self {
      page_number: page.page,
      markdown: page.markdown,
    }
  }
}

impl From<WirePageBlocks> for PdfPageBlocks {
  fn from(page: WirePageBlocks) -> Self {
    Self {
      page_number: page.page,
      width: page.width,
      height: page.height,
      status: page.status,
      items: page
        .items
        .into_iter()
        .map(|item| PdfBlockItem {
          id: item.id,
          r#type: item.r#type,
          label: item.label,
          bbox: item.bbox,
          content: item.content,
          markdown_span: item.markdown_span,
          reading_order: item.reading_order,
          source: item.source,
          confidence: PdfBlockItemConfidence {
            layout: item.confidence.layout,
            ocr: item.confidence.ocr,
          },
        })
        .collect(),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields = nullable)]
pub struct PdfOptions {
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub mode: PdfMode,

  pub max_pages: Option<u32>,

  /// Include physical per-page markdown alongside document markdown.
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub pages: bool,

  /// Include per-page types layout blocks (bounding boxes, block types, reading order) alongside document markdown.
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub blocks: bool,

  /// Join PDF pages in `document.markdown` with `\n\n---\n\n<!-- page N -->\n\n` where N is the 1-based physical page
  /// of the content that follows. Markers appear between pages only (no leading marker for page 1), and numbering may
  /// skip pages merged by cross-page stitching — callers that need every physical page should use `pages: true` instead.
  /// No new response field.
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub page_markers: bool,

  /// Skip the cached conversion for this document and parse it again; the fresh result replaces the cache entry.
  #[serde(default)]
  #[ts(as = "Option<_>", optional)]
  pub refresh: bool,

  /// Experimental opt-in to fire-pdf's async jobs, honored only where the deployment allows request overrides.
  #[serde(default, rename = "__firePdfAsync")]
  #[ts(as = "Option<_>", optional)]
  pub fire_pdf_async: bool,
}

impl PdfOptions {
  /// Page markdown, blocks and page markers only exist on FirePDF output.
  pub fn page_aware(&self) -> bool {
    self.pages || self.blocks || self.page_markers
  }
}
