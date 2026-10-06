use std::{sync::LazyLock, time::Duration};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{Span, instrument};
use url::Url;

use super::super::{document::Document, meta::Meta, raw_page::BrowserCookie};
use super::TransformerError;

const NAME: &str = "youtube";

// Best-effort enrichment: bound the avgrab call so a slow extraction can't eat the scrape budget.
const METADATA_FETCH_TIMEOUT: Duration = Duration::from_secs(45);

static AVGRAB_SERVICE_URL: LazyLock<Option<String>> = LazyLock::new(|| {
  if let Some(url) = std::env::var("AVGRAB_SERVICE_URL").ok()
    && !url.is_empty()
  {
    Some(url)
  } else {
    None
  }
});

#[derive(Debug, thiserror::Error)]
enum YouTubeMetadataError {
  #[error(transparent)]
  Reqwest(#[from] reqwest::Error),

  #[error("YouTube metadata extraction failed: {0}")]
  Service(String),

  #[error("YouTube metadata extraction failed: avgrab service returned an invalid response")]
  InvalidResponse,
}

#[derive(Serialize)]
struct YouTubeMetadataRequest<'a> {
  url: &'a str,
  transcript_language: String,
  #[serde(skip_serializing_if = "<[_]>::is_empty")]
  cookies: &'a [BrowserCookie],
}

#[derive(Deserialize)]
struct YouTubeThumbnail {
  url: String,
  width: Option<f64>,
  height: Option<f64>,
}

#[derive(Deserialize)]
struct YouTubeUploadedBy {
  name: Option<String>,
  url: Option<String>,
}

#[derive(Deserialize)]
struct YouTubeMetadata {
  thumbnail_image: YouTubeThumbnail,
  title: String,
  visibility: Option<String>,
  uploaded_by: Option<YouTubeUploadedBy>,
  uploaded_at: Option<String>,
  published_at: Option<String>,
  length: Option<String>,
  views: Option<f64>,
  likes: Option<f64>,
  category: Option<String>,
  description: Option<String>,
  transcript: Option<String>,
}

/// Whether `url` is a YouTube video page. Fire-engine loads media and requests
/// cookies for these so this transformer can pass them to avgrab.
pub fn is_youtube_video_url(url: &Url) -> bool {
  let Some(host) = url.host_str() else {
    return false;
  };

  if host == "youtube.com" || host.ends_with(".youtube.com") {
    let is_watch = url.path() == "/watch"
      && url
        .query_pairs()
        .find(|(key, _)| key == "v")
        .is_some_and(|(_, value)| !value.is_empty());
    let segments: Vec<&str> = url.path().split('/').filter(|x| !x.is_empty()).collect();
    is_watch || (segments.len() == 2 && segments[0] == "live")
  } else if host == "youtu.be" {
    url.path() != "/"
  } else {
    false
  }
}

fn transcript_language(meta: &Meta) -> String {
  meta
    .options
    .location
    .languages
    .first()
    .and_then(|language| language.split(['-', '_']).next())
    .map(str::to_lowercase)
    .filter(|language| !language.is_empty())
    .unwrap_or_else(|| "en".to_string())
}

fn format_number(value: Option<f64>) -> String {
  value.map(|x| x.to_string()).unwrap_or_default()
}

fn format_uploaded_by(uploaded_by: Option<&YouTubeUploadedBy>) -> String {
  let name = uploaded_by.and_then(|x| x.name.as_deref()).unwrap_or("");
  let url = uploaded_by.and_then(|x| x.url.as_deref()).unwrap_or("");

  match (name.is_empty(), url.is_empty()) {
    (false, false) => format!("[{name}]({url})"),
    (false, true) => name.to_string(),
    (true, _) => url.to_string(),
  }
}

fn build_markdown(metadata: &YouTubeMetadata, source_url: &str) -> String {
  let thumbnail = &metadata.thumbnail_image;
  let thumbnail_dimensions = match (thumbnail.width, thumbnail.height) {
    (Some(width), Some(height)) if width != 0.0 && height != 0.0 => {
      format!(" ({width}x{height})")
    }
    _ => String::new(),
  };

  let mut sections = vec![
    format!(
      "![Thumbnail{thumbnail_dimensions}]({})\n# [{}]({source_url})\n\n**Visibility**: {}\n**Uploaded by**: {}\n**Uploaded at**: {}\n**Published at**: {}\n**Length**: {}\n**Views**: {}\n**Likes**: {}\n**Category**: {}",
      thumbnail.url,
      metadata.title,
      metadata.visibility.as_deref().unwrap_or(""),
      format_uploaded_by(metadata.uploaded_by.as_ref()),
      metadata.uploaded_at.as_deref().unwrap_or(""),
      metadata.published_at.as_deref().unwrap_or(""),
      metadata.length.as_deref().unwrap_or(""),
      format_number(metadata.views),
      format_number(metadata.likes),
      metadata.category.as_deref().unwrap_or(""),
    ),
    format!(
      "## Description\n\n```\n{}\n```",
      metadata.description.as_deref().unwrap_or("")
    ),
  ];

  if let Some(transcript) = metadata.transcript.as_deref()
    && !transcript.is_empty()
  {
    sections.push(format!("## Transcript\n\n{transcript}"));
  }

  sections.join("\n\n")
}

#[instrument(
  name = "transformers::youtube::fetch_metadata",
  skip_all,
  fields(
    avgrab.transcript_language = tracing::field::Empty,
    avgrab.cookies = meta.audio_cookies.len(),
    avgrab.status = tracing::field::Empty,
    avgrab.has_transcript = tracing::field::Empty,
  ),
  err
)]
async fn fetch_metadata(
  meta: &Meta,
  service_url: &str,
  source_url: &str,
) -> Result<YouTubeMetadata, YouTubeMetadataError> {
  let span = Span::current();
  let transcript_language = transcript_language(meta);
  span.record("avgrab.transcript_language", transcript_language.as_str());

  let response = Client::builder()
    .timeout(METADATA_FETCH_TIMEOUT)
    .build()?
    .post(format!("{service_url}/metadata"))
    .json(&YouTubeMetadataRequest {
      url: source_url,
      transcript_language,
      cookies: &meta.audio_cookies,
    })
    .send()
    .await?;

  let status = response.status();
  span.record("avgrab.status", status.as_u16());
  let body = response.bytes().await?;

  if !status.is_success() {
    let detail = serde_json::from_slice::<Value>(&body)
      .ok()
      .and_then(|x| x.get("detail").cloned())
      .map(|detail| match detail {
        Value::String(x) => x,
        other => other.to_string(),
      })
      .unwrap_or_else(|| "Unknown error".to_string());
    return Err(YouTubeMetadataError::Service(detail));
  }

  let metadata: YouTubeMetadata =
    serde_json::from_slice(&body).map_err(|_| YouTubeMetadataError::InvalidResponse)?;
  span.record(
    "avgrab.has_transcript",
    metadata.transcript.as_ref().is_some_and(|x| !x.is_empty()),
  );
  Ok(metadata)
}

/// Replaces markdown with avgrab's metadata and transcript. Failures keep the
/// page as scraped, like the TS postprocessor loop.
#[instrument(
  name = "transformers::youtube::fetch_youtube",
  skip(meta, document),
  fields(youtube.outcome = tracing::field::Empty),
  err
)]
pub async fn fetch_youtube(
  meta: &Meta,
  mut document: Document,
) -> Result<Document, TransformerError> {
  let span = Span::current();
  let already_ran = document
    .metadata
    .postprocessors_used
    .as_ref()
    .is_some_and(|x| x.iter().any(|x| x == NAME));

  let skipped = if !is_youtube_video_url(&document.metadata.url) {
    Some("not_video_url")
  } else if already_ran {
    Some("already_ran")
  } else if meta.options.lockdown {
    Some("lockdown")
  } else {
    None
  };
  if let Some(reason) = skipped {
    span.record("youtube.outcome", reason);
    return Ok(document);
  }

  let Some(service_url) = AVGRAB_SERVICE_URL.as_deref() else {
    span.record("youtube.outcome", "avgrab_not_configured");
    return Ok(document);
  };

  let source_url = document.metadata.url.to_string();
  match fetch_metadata(meta, service_url, &source_url).await {
    Ok(metadata) => {
      span.record("youtube.outcome", "enriched");
      document.markdown = Some(build_markdown(&metadata, &source_url));
      document
        .metadata
        .postprocessors_used
        .get_or_insert_with(Vec::new)
        .push(NAME.to_string());
    }
    Err(_) => {
      span.record("youtube.outcome", "avgrab_failed");
    }
  }

  Ok(document)
}
