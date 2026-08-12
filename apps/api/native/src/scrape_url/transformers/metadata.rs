use crate::_extract_metadata;

use super::super::{document::Document, meta::Meta};
use super::TransformerError;

pub async fn derive_metadata_from_raw_html(
  meta: &Meta,
  mut document: Document,
) -> Result<Document, TransformerError> {
  let Some(raw_html) = document.raw_html.clone() else {
    return Err(TransformerError::CalledOutOfOrder(
      "raw_html is None".to_string(),
    ));
  };

  let metadata = tokio::task::spawn_blocking(move || _extract_metadata(&raw_html))
    .await
    .unwrap()
    .unwrap(); // TODO: error handling

  // TODO: unmerge stuff like `title` and other defined tags (or rework metadata completely...)
  document.metadata.extra = metadata;

  unimplemented!()
}
