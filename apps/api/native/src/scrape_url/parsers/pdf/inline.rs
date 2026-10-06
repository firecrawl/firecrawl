//! FirePDF over inline base64: the content cache, then async jobs or sync `/ocr`.

use base64::Engine;
use bytes::Bytes;
use tracing::{Span, field::Empty};

use super::firepdf::{
  AsyncInput, AsyncRouteInput, FirePdfClient, FirePdfError, FirePdfJobOptions, FirePdfResult,
  RouteRecord, decide_async_route, features_label, now_ms, sha256_hex,
};

/// The base64 payload, plus the cache keys it may be stored under: the raw bytes'
/// hash first, then the historical hash of the base64 payload.
fn base64_with_cache_keys(bytes: &[u8], with_cache_keys: bool) -> (String, Option<Vec<String>>) {
  let pdf_b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
  let keys = with_cache_keys.then(|| {
    vec![
      format!("raw-{}", sha256_hex(bytes)),
      sha256_hex(pdf_b64.as_bytes()),
    ]
  });
  (pdf_b64, keys)
}

/// `route_span` receives the transport decision.
#[tracing::instrument(
  name = "parsers::pdf::fire_pdf_inline",
  skip_all,
  fields(fire_pdf.cache_hit = Empty, fire_pdf.sync_retry = Empty),
  err
)]
pub async fn fire_pdf_inline(
  client: &FirePdfClient<'_>,
  bytes: &Bytes,
  options: &FirePdfJobOptions,
  request_opt_in: bool,
  route_span: &Span,
) -> Result<FirePdfResult, FirePdfError> {
  let request = client.request;
  let with_cache_keys = client.cache_applicable(options);
  let (pdf_b64, cache_keys) = {
    let bytes = bytes.clone();
    tokio::task::spawn_blocking(move || base64_with_cache_keys(&bytes, with_cache_keys)).await
  }
  .unwrap_or_else(|_| base64_with_cache_keys(bytes, with_cache_keys));

  let remaining_ms = request.remaining_ms(now_ms());
  let (use_async, reason) = decide_async_route(
    client.config,
    &AsyncRouteInput {
      scrape_id: &request.scrape_id,
      team_id: &request.team_id,
      zdr: request.zdr,
      remaining_ms,
      request_opt_in,
      bulk_origin: request.crawl_id.is_some(),
    },
  );
  RouteRecord {
    path: if use_async { "async" } else { "sync" },
    reason: reason.as_str(),
    features: &features_label(options.page_markdown, options.blocks, options.page_markers),
    remaining_ms,
  }
  .record(route_span);

  let span = Span::current();
  let cached = match cache_keys {
    Some(keys) => client.lookup_cache(&keys, options).await,
    None => None,
  };
  span.record("fire_pdf.cache_hit", cached.is_some());
  if let Some(cached) = cached {
    return Ok(cached);
  }

  if !use_async {
    return client.ocr_sync(&pdf_b64, options).await;
  }
  match client
    .run_async(AsyncInput::Inline(&pdf_b64), options)
    .await
  {
    Err(error) if options.page_markdown || options.blocks || options.page_markers => {
      span.record("fire_pdf.sync_retry", true);
      tracing::error!(error = %error, "FirePDF async failed; retrying sync");
      client.ocr_sync(&pdf_b64, options).await
    }
    result => result,
  }
}
