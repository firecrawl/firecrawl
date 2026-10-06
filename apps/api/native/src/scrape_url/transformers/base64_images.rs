use regex::{Captures, regex};
use tracing::{Span, instrument};

use super::super::{document::Document, meta::Meta};
use super::TransformerError;

#[instrument(
  name = "transformers::base64_images::remove_base64_images",
  skip(meta, document),
  fields(base64_images.removed = tracing::field::Empty),
  err
)]
pub async fn remove_base64_images(
  meta: &Meta,
  mut document: Document,
) -> Result<Document, TransformerError> {
  if meta.options.remove_base64_images
    && let Some(markdown) = document.markdown.as_deref()
  {
    let mut removed = 0;
    let replaced = regex!(r"(!\[.*?\])\(data:image/.*?;base64,.*?\)").replace_all(
      markdown,
      |caps: &Captures| {
        removed += 1;
        format!("{}(<Base64-Image-Removed>)", &caps[1])
      },
    );
    let replaced = replaced.into_owned();
    Span::current().record("base64_images.removed", removed);
    document.markdown = Some(replaced);
  }

  Ok(document)
}
