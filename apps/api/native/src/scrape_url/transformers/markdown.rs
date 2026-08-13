use std::sync::LazyLock;

use reqwest::{
  Client,
  header::{HeaderMap, HeaderValue},
};
use serde::{Deserialize, Serialize};
use tracing::instrument;

use crate::{_post_process_markdown, scrape_url::transformers::html::_derive_html_from_raw_html};

use super::super::{document::Document, formats::FormatKind, meta::Meta};
use super::TransformerError;

static HTML_TO_MARKDOWN_SERVICE_URL: LazyLock<Option<String>> = LazyLock::new(|| {
  if let Some(url) = std::env::var("HTML_TO_MARKDOWN_SERVICE_URL").ok()
    && !url.is_empty()
  {
    Some(url)
  } else {
    None
  }
});

#[derive(Serialize)]
struct ConvertRequest<'a> {
  html: &'a str,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ConvertResponse {
  Failure {
    // success: bool,
    error: String,
    details: Option<String>,
  },
  Success {
    // success: bool,
    markdown: String,
  },
}

#[instrument(
  name = "transformers::markdown::convert_markdown_to_html",
  skip(meta, html)
)]
async fn convert_markdown_to_html(meta: &Meta, html: &str) -> String {
  let client = Client::new(); // TODO: cache and share

  let mut headers = HeaderMap::new();

  if meta.internal_options.zero_data_retention {
    headers.insert("X-Zero-Data-Retention", HeaderValue::from_static("true"));
  } else if let Ok(val) = HeaderValue::from_str(&meta.id) {
    headers.insert("X-Request-ID", val);
  }

  // TODO: timeout
  let res = client
    .post(format!(
      "{}/convert",
      HTML_TO_MARKDOWN_SERVICE_URL
        .as_ref()
        .expect("html to markdown service is not configured")
    )) // TODO: error handling
    .headers(headers)
    .json(&ConvertRequest { html })
    .send()
    .await
    .unwrap(); // TODO: error handling

  if !res.status().is_success() {
    unimplemented!(); // TODO: error handling
  }

  let res = res.json::<ConvertResponse>().await.unwrap(); // TODO: error handling

  let markdown = match res {
    ConvertResponse::Failure { .. } => unimplemented!(), // TODO: error handling
    ConvertResponse::Success { markdown, .. } => markdown,
  };

  tokio::task::spawn_blocking(move || _post_process_markdown(markdown))
    .await
    .unwrap() // TODO: error handling
}

#[instrument(
  name = "transformers::markdown:derive_markdown_from_html",
  skip(meta, document)
)]
pub async fn derive_markdown_from_html(
  meta: &Meta,
  mut document: Document,
) -> Result<Document, TransformerError> {
  // Only skip markdown conversion if nothing requires it to be present.
  if !meta.options.formats.contains(FormatKind::Markdown)
    && !meta.options.formats.contains(FormatKind::ChangeTracking)
    && !meta.options.formats.contains(FormatKind::Json)
    && !meta.options.formats.contains(FormatKind::DeterministicJson)
    && !meta.options.formats.contains(FormatKind::Summary)
    && !meta.options.formats.contains(FormatKind::Question)
    && !meta.options.formats.contains(FormatKind::Highlights)
    && !meta.options.formats.contains(FormatKind::Query)
    // && meta.options.redact_pii.is_none() // TODO:
    && !meta.options.only_clean_content
  {
    return Ok(document);
  }

  // Skip markdown conversion if it's already present via engine or parser
  if document.markdown.is_some() {
    return Ok(document);
  }

  let Some(html) = document.html.as_ref() else {
    return Err(TransformerError::CalledOutOfOrder(
      "html is None".to_string(),
    ));
  };

  let markdown = convert_markdown_to_html(meta, html).await;

  // If OMC is on and resulting markdown was empty, re-derive html and markdown without OMC
  if meta.options.only_main_content && markdown.trim().is_empty() {
    let html = _derive_html_from_raw_html(&meta, &document, false).await?;
    document.markdown = Some(convert_markdown_to_html(&meta, &html).await);
    document.html = Some(html);
  } else {
    document.markdown = Some(markdown);
  }

  Ok(document)
}
