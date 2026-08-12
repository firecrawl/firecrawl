use tokio::task;

use crate::{_transform_html_inner, TransformHtmlOptions};

use super::super::{document::Document, meta::Meta};
use super::TransformerError;

pub async fn _derive_html_from_raw_html(
  meta: &Meta,
  document: &Document,
  only_main_content: bool,
) -> Result<String, TransformerError> {
  let Some(raw_html) = document.raw_html.as_ref() else {
    return Err(TransformerError::CalledOutOfOrder(
      "raw_html is None".to_string(),
    ));
  };

  let raw_html = raw_html.clone();
  let url = meta.get_url().to_string();
  let include_tags = meta.options.include_tags.clone();
  let exclude_tags = meta.options.exclude_tags.clone();
  let html = task::spawn_blocking(move || {
    _transform_html_inner(TransformHtmlOptions {
      html: raw_html,
      url: url,

      include_tags,
      exclude_tags,

      only_main_content,
      omce_signatures: None, // TODO: omce support
    })
  })
  .await
  .unwrap()
  .unwrap(); // TODO: error handling

  Ok(html)
}

pub async fn derive_html_from_raw_html(
  meta: &Meta,
  mut document: Document,
) -> Result<Document, TransformerError> {
  let html = _derive_html_from_raw_html(&meta, &document, meta.options.only_main_content).await?;
  document.html = Some(html);
  Ok(document)
}
