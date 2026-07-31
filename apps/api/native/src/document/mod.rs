pub mod encoding;
pub mod model;
pub mod oleps;
pub mod providers;
pub mod renderers;
pub mod xml;

pub use providers::factory::DocumentType;

use crate::document::model::Document;
use crate::document::providers::factory::ProviderFactory;
use crate::document::renderers::html::HtmlRenderer;
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub struct DocumentConverter {
  factory: ProviderFactory,
  html_renderer: HtmlRenderer,
}

impl Default for DocumentConverter {
  fn default() -> Self {
    Self::new()
  }
}

#[napi]
impl DocumentConverter {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self {
      factory: ProviderFactory::new(),
      html_renderer: HtmlRenderer::new(),
    }
  }

  #[napi]
  pub fn convert_buffer_to_html(
    &self,
    data: &[u8],
    doc_type: DocumentType,
  ) -> napi::Result<String> {
    let provider = self.factory.get_provider(doc_type);

    let document: Document = provider
      .parse_buffer(data)
      .map_err(|e| Error::new(Status::GenericFailure, format!("Provider error: {e}")))?;

    let html = self.html_renderer.render(&document);
    Ok(html)
  }
}
