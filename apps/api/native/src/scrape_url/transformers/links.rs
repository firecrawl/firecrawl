use tracing::instrument;

use crate::_extract_links;

use super::super::{document::Document, formats::FormatKind, meta::Meta};
use super::TransformerError;

#[instrument(
  name = "transformers::links::derive_links_from_html",
  skip(meta, document)
)]
pub async fn derive_links_from_html(
  meta: &Meta,
  mut document: Document,
) -> Result<Document, TransformerError> {
  if !meta.options.formats.contains(FormatKind::Links) {
    return Ok(document);
  }

  let Some(html) = document.html.clone() else {
    return Err(TransformerError::CalledOutOfOrder(
      "raw_html is None".to_string(),
    ));
  };

  // TODO: forward links to indexer if enabled

  // TODO: fix exchange logic

  let links = tokio::task::spawn_blocking(move || _extract_links(&html))
    .await
    .unwrap()
    .unwrap(); // TODO: error handling

  document.links = Some(links);

  Ok(document)
}
