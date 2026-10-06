use std::collections::HashSet;

// use napi::bindgen_prelude::*;
use napi_derive::napi;
use tracing::{Instrument, Span, field::Empty};
use url::Url;

use self::{
  document::{Document, DocumentMetadataCacheState},
  engines::{EngineOutcome, check_engine_support, get_main_engine, should_elevate_proxy},
  error::{ScrapeErrorPayload, ScrapeURLError},
  feature_flags::FeatureFlag,
  index::{Index, should_use_index},
  meta::Meta,
  options::{InternalOptions, ScrapeOptions},
  raw_page::{RawPage, RawPageSource, ScrapeProxy},
  transformers::execute_tranformers,
};

mod actions;
mod document;
mod engines;
mod error;
mod feature_flags;
mod file_size_limit;
mod formats;
mod index;
mod kinded;
mod llm;
mod meta;
mod options;
mod parsers;
mod raw_page;
mod rewrite_url;
mod robots;
mod transformers;
mod ts_bindings;

pub use self::ts_bindings::render_scrape_url_ts_bindings;

async fn _scrape_url(mut meta: Meta) -> Result<Document, ScrapeURLError> {
  tracing::info!("scrapeURL entered");

  if let Some(rewritten_url) = meta.rewritten_url.as_ref() {
    Span::current().record("rewritten_url", rewritten_url.as_str());
    tracing::info!("Rewriting URL");
  }

  robots::do_robots_check_if_needed(&meta).await?;

  tracing::info!("Scraping URL...");

  let discrete_proxy = match meta.options.proxy {
    options::ProxyMode::Auto | options::ProxyMode::Basic => ScrapeProxy::Basic,
    options::ProxyMode::Enhanced => ScrapeProxy::Enhanced,
  };

  let should_use_index = should_use_index(&meta);

  let index_page = {
    if !should_use_index {
      if meta.options.lockdown {
        return Err(ScrapeURLError::LockdownMissError);
      }
      if meta.internal_options.agent_index_only {
        return Err(ScrapeURLError::AgentIndexOnlyError);
      }
    }

    if should_use_index {
      match Index::get().await {
        Ok(Some(index)) => index
          .lookup(&meta, discrete_proxy)
          .await
          .ok()
          .flatten()
          .map(|result| RawPage {
            source: RawPageSource::Index,
            result,
            index_attempted: true,
          }),
        _ => None,
      }
    } else {
      None
    }
  };

  let mut page = match index_page {
    Some(index_page) => index_page,
    None if meta.options.lockdown => return Err(ScrapeURLError::LockdownMissError),
    None if meta.internal_options.agent_index_only => {
      return Err(ScrapeURLError::AgentIndexOnlyError);
    }
    None => {
      let main_engine = get_main_engine().await;
      Span::current().record("engine", main_engine.get_name());

      check_engine_support(
        !meta.options.actions.is_empty(),
        meta.options.profile.is_some(),
        main_engine.get_features().contains(FeatureFlag::Actions),
        main_engine.supports_profile(),
      )?;

      let mut outcome = main_engine.scrape(&meta, discrete_proxy).await?;

      let elevation_reason = should_elevate_proxy(
        meta.options.proxy,
        discrete_proxy,
        main_engine.supports_enhanced_proxy(),
        &outcome,
      );
      Span::current().record("proxy_elevated", elevation_reason.is_some());

      if let Some(reason) = elevation_reason {
        Span::current().record("proxy_elevation_reason", reason);
        outcome = main_engine.scrape(&meta, ScrapeProxy::Enhanced).await?;
      }

      match outcome {
        EngineOutcome::Scraped(result) => RawPage {
          source: RawPageSource::Engine(
            main_engine,
            HashSet::new(), // TODO
          ),
          result,
          index_attempted: should_use_index,
        },
        EngineOutcome::ProxyElevationNeeded => {
          return Err(ScrapeURLError::ReliableRetrievalError(meta.options.proxy));
        }
      }
    }
  };

  meta.audio_cookies = std::mem::take(&mut page.result.audio_cookies);

  let cached_at = page.result.cached_at;
  let mut document = parsers::parse_engine_result(&meta, page.result).await?;
  if page.index_attempted {
    if let Some(cached_at) = cached_at {
      document.metadata.cache_state = DocumentMetadataCacheState::Hit;
      document.metadata.cached_at = Some(cached_at);
    } else {
      document.metadata.cache_state = DocumentMetadataCacheState::Miss;
    }
  }

  if let Some(unsupported_features) = page.source.unsupported_features()
    && !unsupported_features.is_empty()
  {
    document.append_warning(format!(
      "The engine used does not support the following features: {} -- your scrape may be partial.",
      unsupported_features
        .iter()
        .map(|x| x.to_string())
        .collect::<Vec<String>>()
        .join(", ")
    ));
  }

  let document = execute_tranformers(&meta, document).await?;

  // log metrics

  // return result

  // also error handling

  Ok(document)
}

// Several dependencies (sqlx, the GCS client's HTTP stack) link rustls but
// leave the process-level CryptoProvider ambiguous, which makes rustls panic on
// the first TLS handshake. Install the ring provider once before any TLS runs.
static CRYPTO_PROVIDER_INIT: std::sync::Once = std::sync::Once::new();

fn ensure_crypto_provider() {
  CRYPTO_PROVIDER_INIT.call_once(|| {
    let _ = rustls::crypto::ring::default_provider().install_default();
  });
}

fn napi_error(e: ScrapeURLError) -> napi::Error {
  napi::Error::new(napi::Status::GenericFailure, e.to_transport_string())
}

fn parse_input<T: serde::de::DeserializeOwned>(
  argument: &'static str,
  value: serde_json::Value,
) -> Result<T, ScrapeURLError> {
  serde_path_to_error::deserialize(value).map_err(|e| {
    let span = Span::current();
    span.record("input.argument", argument);
    span.record("input.path", e.path().to_string());
    ScrapeURLError::InvalidInput {
      argument,
      error: e.to_string(),
    }
  })
}

/// Runs `fut` as its own task, so a panic inside it surfaces as
/// [`ScrapeURLError::Panic`] instead of an untyped rejection.
async fn catch_panic<T: Send + 'static>(
  fut: impl Future<Output = Result<T, ScrapeURLError>> + Send + 'static,
) -> Result<T, ScrapeURLError> {
  match tokio::spawn(fut).await {
    Ok(result) => result,
    Err(e) => Err(ScrapeURLError::Panic(match e.try_into_panic() {
      Ok(payload) => payload
        .downcast_ref::<&str>()
        .map(|x| x.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string panic payload".to_string()),
      Err(e) => e.to_string(),
    })),
  }
}

/// Scrapes `url`. A rejection's message is `CODE|{json}`; decode it with
/// `decodeScrapeUrlError`.
#[napi(
  ts_args_type = "id: string, url: string, teamId: string, options: ScrapeUrl.ScrapeOptions, internalOptions: ScrapeUrl.InternalOptions",
  ts_return_type = "Promise<ScrapeUrl.Document>"
)]
pub async fn scrape_url(
  id: String,
  url: String,
  team_id: String,
  options: serde_json::Value,
  internal_options: serde_json::Value,
  // cost_tracking: // TODO:
) -> Result<serde_json::Value, napi::Error> {
  // Flushes after the scrape span closes, including when the scrape panicked.
  let _flush = crate::telemetry::FlushGuard;

  ensure_crypto_provider();
  crate::telemetry::init_telemetry();

  // Read before parsing so the sampler drops a ZDR scrape even when its input
  // is invalid. Any value but `false` counts as ZDR.
  let zero_data_retention = internal_options
    .get("zeroDataRetention")
    .is_some_and(|x| x != &serde_json::Value::Bool(false));

  let span = tracing::info_span!(
    "scrape_url",
    scrape_id = id.as_str(),
    scrape_url = Empty,
    zero_data_retention,
    team_id = team_id.as_str(),
    features = Empty,
    options = options.to_string(),
    internal_options = internal_options.to_string(),
    rewritten_url = Empty,
    engine = Empty,
    proxy_elevated = Empty,
    proxy_elevation_reason = Empty,
    input.argument = Empty,
    input.path = Empty,
    error.code = Empty,
    panicked = Empty,
  );

  let result = catch_panic(
    scrape_url_task(id, url, team_id, options, internal_options).instrument(span.clone()),
  )
  .await;

  if let Err(e) = &result {
    let transport = e.to_transport_string();
    let code = transport.split_once('|').map_or("", |(code, _)| code);
    span.record("error.code", code);
    if matches!(e.payload(), ScrapeErrorPayload::Panic { .. }) {
      span.record("panicked", true);
    }
    // The ZDR layer vetoes this event, so a ZDR panic's payload never leaves.
    span.in_scope(|| tracing::error!(error = %e));
  }

  result.map_err(napi_error)
}

async fn scrape_url_task(
  id: String,
  url: String,
  team_id: String,
  options: serde_json::Value,
  internal_options: serde_json::Value,
) -> Result<serde_json::Value, ScrapeURLError> {
  let options: ScrapeOptions = parse_input("options", options)?;
  let internal_options: InternalOptions = parse_input("internalOptions", internal_options)?;
  let url = Url::parse(&url).map_err(|_| ScrapeURLError::InvalidURLError)?;

  let meta = Meta::new(id, url, team_id, options, internal_options);

  let span = Span::current();
  span.record("scrape_url", meta.url.as_str());
  span.record(
    "features",
    meta
      .feature_flags
      .iter()
      .cloned()
      .map(|x| x.to_string())
      .collect::<Vec<String>>()
      .join(","),
  );

  Ok(serde_json::to_value(_scrape_url(meta).await?)?)
}

/// Decodes the message of a `scrapeUrl` rejection into its typed payload.
/// Returns null for errors that did not come from `scrapeUrl`.
#[napi(catch_unwind, ts_return_type = "ScrapeUrl.ScrapeError | null")]
pub fn decode_scrape_url_error(message: String) -> Option<serde_json::Value> {
  ScrapeErrorPayload::from_transport_string(&message).and_then(|x| serde_json::to_value(x).ok())
}
