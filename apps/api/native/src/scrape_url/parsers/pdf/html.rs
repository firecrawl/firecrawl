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
#[tracing::instrument(
  name = "parsers::pdf::markdown_to_html",
  skip_all,
  fields(markdown_length = markdown.len(), fell_back = Empty)
)]
pub async fn markdown_to_html(markdown: &str) -> String {
  let owned = markdown.to_string();
  let rendered = tokio::task::spawn_blocking(move || {
    markdown::to_html_with_options(&owned, &markdown::Options::gfm()).map_err(|e| e.to_string())
  })
  .await
  .map_err(|e| e.to_string())
  .and_then(|x| x);
  match rendered {
    Ok(html) => html,
    Err(error) => {
      Span::current().record("fell_back", true);
      tracing::error!(error = %error);
      format!("<pre>{}</pre>", escape_html(markdown))
    }
  }
}
