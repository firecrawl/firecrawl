use std::sync::Arc;

use tracing::{Span, field::Empty};

fn escape_html(text: &str) -> String {
  text
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
    .replace('\'', "&#39;")
}

/// GFM to HTML off the async workers, falling back to an escaped `<pre>` block.
/// Hands the markdown back with the HTML; the blocking task shares it instead of copying it.
#[tracing::instrument(
  name = "parsers::pdf::markdown_to_html",
  skip_all,
  fields(markdown_length = markdown.len(), fell_back = Empty)
)]
pub async fn markdown_to_html(markdown: String) -> (String, String) {
  let shared = Arc::new(markdown);
  let input = Arc::clone(&shared);
  let rendered = tokio::task::spawn_blocking(move || {
    markdown::to_html_with_options(&input, &markdown::Options::gfm()).map_err(|e| e.to_string())
  })
  .await
  .map_err(|e| e.to_string())
  .and_then(|x| x);
  let markdown = Arc::unwrap_or_clone(shared);
  let html = match rendered {
    Ok(html) => html,
    Err(error) => {
      Span::current().record("fell_back", true);
      tracing::error!(error = %error);
      format!("<pre>{}</pre>", escape_html(&markdown))
    }
  };
  (markdown, html)
}
