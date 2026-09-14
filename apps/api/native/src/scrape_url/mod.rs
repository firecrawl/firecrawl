use std::collections::HashSet;

// use napi::bindgen_prelude::*;
use napi_derive::napi;
use tracing::{Instrument, Span, field::Empty};
use url::Url;

use self::{
  document::{Document, DocumentMetadataCacheState},
  engines::{EngineOutcome, get_main_engine},
  error::ScrapeURLError,
  index::{Index, should_use_index},
  meta::Meta,
  options::{InternalOptions, ProxyMode, ScrapeOptions},
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

async fn _scrape_url(meta: Meta) -> Result<Document, ScrapeURLError> {
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

  let page = match index_page {
    Some(index_page) => index_page,
    None if meta.options.lockdown => return Err(ScrapeURLError::LockdownMissError),
    None if meta.internal_options.agent_index_only => {
      return Err(ScrapeURLError::AgentIndexOnlyError);
    }
    None => {
      let main_engine = get_main_engine().await;

      match main_engine.scrape(&meta, discrete_proxy).await? {
        EngineOutcome::Scraped(result) => RawPage {
          source: RawPageSource::Engine(
            main_engine,
            HashSet::new(), // TODO
          ),
          result,
          index_attempted: should_use_index,
        },

        // If basic proxy failed due to proxy error, and proxy mode is auto,
        // retry the main engine with enhanced proxies.
        EngineOutcome::ProxyElevationNeeded
          if meta.options.proxy == ProxyMode::Auto
            && discrete_proxy == ScrapeProxy::Basic =>
        {
          match main_engine
            .scrape(&meta, ScrapeProxy::Enhanced)
            .await?
          {
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
        EngineOutcome::ProxyElevationNeeded => {
          return Err(ScrapeURLError::ReliableRetrievalError(meta.options.proxy));
        }
      }
    }
  };

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

// wrapper that lets us avoid exposing Meta in JS-land
#[napi]
pub async fn scrape_url(
  id: String,
  url: String,
  team_id: String,
  options: serde_json::Map<String, serde_json::Value>,
  internal_options: serde_json::Map<String, serde_json::Value>,
  // cost_tracking: // TODO:
) -> Result<serde_json::Map<String, serde_json::Value>, napi::Error> {
  ensure_crypto_provider();
  crate::telemetry::init_telemetry();
  // Flushes on scope exit AND on panic unwind, so even a panicking scrape
  // exports the spans it produced before the process tears down.
  let _flush = crate::telemetry::FlushGuard;

  let options_raw = serde_json::Value::Object(options);
  let internal_options_raw = serde_json::Value::Object(internal_options);
  let options_json = options_raw.to_string();
  let internal_options_json = internal_options_raw.to_string();

  let options: ScrapeOptions = serde_json::from_value(options_raw)
    .map_err(ScrapeURLError::from)
    .map_err(napi_error)?;
  let internal_options: InternalOptions = serde_json::from_value(internal_options_raw)
    .map_err(ScrapeURLError::from)
    .map_err(napi_error)?;
  let url = Url::parse(&url)
    .map_err(|_| ScrapeURLError::InvalidURLError)
    .map_err(napi_error)?;

  let meta = Meta::new(id, url, team_id, options, internal_options);

  let span = tracing::info_span!(
    "scrape_url",
    scrape_id = meta.id.as_str(),
    scrape_url = meta.url.as_str(),
    zero_data_retention = meta.internal_options.zero_data_retention,
    team_id = meta.team_id.as_str(),
    features = meta.feature_flags.iter().cloned().map(|x| x.to_string()).collect::<Vec<String>>().join(","),
    options = options_json,
    internal_options = internal_options_json,
    rewritten_url = Empty,
  );

  let result = _scrape_url(meta).instrument(span.clone()).await;

  if let Err(e) = &result {
    span.in_scope(|| tracing::error!(error = %e));
  }

  match result {
    Ok(x) => Ok(
      match serde_json::to_value(x)
        .map_err(ScrapeURLError::from)
        .map_err(napi_error)?
      {
        serde_json::Value::Object(x) => x,
        _ => unreachable!(),
      },
    ),
    Err(e) => Err(napi_error(e)),
  }
}
