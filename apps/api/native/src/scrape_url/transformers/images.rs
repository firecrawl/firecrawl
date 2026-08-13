use tokio::task;
use tracing::instrument;

use crate::_extract_images;

use super::super::{document::Document, formats::FormatKind, meta::Meta};
use super::TransformerError;

#[instrument(
  name = "transformers::images::derive_images_from_html",
  skip(meta, document)
)]
pub async fn derive_images_from_html(
  meta: &Meta,
  mut document: Document,
) -> Result<Document, TransformerError> {
  if !meta.options.formats.contains(FormatKind::Images) {
    return Ok(document);
  }

  let Some(html) = document.html.as_ref() else {
    return Err(TransformerError::CalledOutOfOrder(
      "html is None".to_string(),
    ));
  };

  let url = meta.get_url().to_string();
  let html = html.clone();
  let images = task::spawn_blocking(move || _extract_images(&html, &url))
    .await
    .unwrap()
    .unwrap(); // TODO: error handling

  document.images = Some(images);
  Ok(document)
}
