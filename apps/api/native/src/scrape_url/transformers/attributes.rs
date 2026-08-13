use tracing::{Span, instrument};

use crate::{_extract_attributes, ExtractAttributesOptions};

use super::super::{
  document::{Document, DocumentAttribute},
  formats::{AttributesOptions, AttributesSelector},
  meta::Meta,
};
use super::TransformerError;

impl Into<ExtractAttributesOptions> for AttributesOptions {
  fn into(self) -> ExtractAttributesOptions {
    ExtractAttributesOptions {
      selectors: self.selectors.into_iter().map(|x| x.into()).collect(),
    }
  }
}

impl Into<crate::AttributeSelector> for AttributesSelector {
  fn into(self) -> crate::AttributeSelector {
    crate::AttributeSelector {
      selector: self.selector,
      attribute: self.attribute,
    }
  }
}

impl Into<DocumentAttribute> for crate::ExtractedAttributeResult {
  fn into(self) -> DocumentAttribute {
    DocumentAttribute {
      selector: self.selector,
      attribute: self.attribute,
      values: self.values,
    }
  }
}

#[instrument(
  name = "transformers::attributes::derive_attributes_from_html",
  skip(meta, document)
)]
pub async fn derive_attributes_from_html(
  meta: &Meta,
  mut document: Document,
) -> Result<Document, TransformerError> {
  let Some(opts) = meta.options.formats.attributes().cloned() else {
    return Ok(document);
  };

  let Some(html) = document.html.clone() else {
    return Err(TransformerError::CalledOutOfOrder(
      "html is None".to_string(),
    ));
  };

  let parent = Span::current();
  let attributes = tokio::task::spawn_blocking(move || {
    let _guard = parent.enter();
    _extract_attributes(&html, &opts.into())
  })
  .await
  .unwrap()
  .unwrap(); // TODO: error handling

  document.attributes = Some(attributes.into_iter().map(|x| x.into()).collect());

  Ok(document)
}
