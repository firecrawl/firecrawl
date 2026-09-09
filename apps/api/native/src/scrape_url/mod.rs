use std::collections::HashSet;

// use napi::bindgen_prelude::*;
use napi_derive::napi;
use tracing::{Span, field::Empty, instrument};
use url::Url;

use self::{
  document::{Document, DocumentMetadataCacheState},
  engines::{
    EngineKind, EngineOutcome, EngineScrapeProxy, EngineScrapeResult, get_main_engine,
    should_use_index,
  },
  error::ScrapeURLError,
  feature_flags::FeatureFlags,
  meta::Meta,
  options::{InternalOptions, ProxyMode, ScrapeOptions},
  transformers::execute_tranformers,
};

mod actions;
mod document;
mod engines;
mod error;
mod feature_flags;
mod file_size_limit;
mod formats;
mod kinded;
mod meta;
mod options;
mod parsers;
mod rewrite_url;
mod robots;
mod transformers;

struct EngineRun {
  engine: EngineKind,
  result: EngineScrapeResult,
  unsupported_features: FeatureFlags,
  index_attempted: bool,
}

#[instrument(
  name = "scrape_url",
  fields(
    scrape_id = meta.id,
    scrape_url = meta.url.as_str(),
    zero_data_retention = meta.internal_options.zero_data_retention,
    team_id = meta.team_id,
    crawl_id = meta.internal_options.crawl_id,
    features = meta.feature_flags.iter().cloned().map(|x| x.to_string()).collect::<Vec<String>>().join(","),
    rewritten_url = Empty,
    is_pre_crawl = meta.internal_options.is_pre_crawl,
    scrape.success = Empty,
    engine.winner = Empty,
    engine.unsupported_features = Empty,
    engine.final_status_code = Empty,
    engine.final_url = Empty,
    engine.proxy_used = Empty,
    engine.cache_state = Empty,
  ),
  skip(meta),
  err
)]
async fn _scrape_url(meta: Meta) -> Result<Document, ScrapeURLError> {
  tracing::info!("scrapeURL entered");

  if let Some(rewritten_url) = meta.rewritten_url.as_ref() {
    Span::current().record("rewritten_url", rewritten_url.as_str());
    tracing::info!("Rewriting URL");
  }

  robots::do_robots_check_if_needed(&meta).await?;

  tracing::info!("Scraping URL...");

  let discrete_proxy = match meta.options.proxy {
    options::ProxyMode::Auto | options::ProxyMode::Basic => engines::EngineScrapeProxy::Basic,
    options::ProxyMode::Enhanced => engines::EngineScrapeProxy::Enhanced,
  };

  let should_use_index = should_use_index(&meta);

  let index_run = {
    if !should_use_index {
      if meta.options.lockdown {
        return Err(ScrapeURLError::LockdownMissError);
      }
      if meta.internal_options.agent_index_only {
        return Err(ScrapeURLError::AgentIndexOnlyError);
      }
    }

    if should_use_index && let Some(index) = EngineKind::index().await {
      match index.scrape(&meta, discrete_proxy).await? {
        EngineOutcome::Scraped(result) => Some(EngineRun {
          engine: index,
          result,
          unsupported_features: HashSet::new(), // TODO
          index_attempted: true,
        }),
        EngineOutcome::IndexMiss => None,
        // TODO: this pattern is disgusting and proof that the index and an engine should be separate primitives
        EngineOutcome::ProxyElevationNeeded => unreachable!(),
      }
    } else {
      None
    }
  };

  let run = match index_run {
    Some(index_run) => index_run,
    None if meta.options.lockdown => return Err(ScrapeURLError::LockdownMissError),
    None if meta.internal_options.agent_index_only => {
      return Err(ScrapeURLError::AgentIndexOnlyError);
    }
    None => {
      let main_engine = get_main_engine().await;

      match main_engine.scrape(&meta, discrete_proxy).await? {
        EngineOutcome::Scraped(result) => EngineRun {
          engine: main_engine,
          result,
          unsupported_features: HashSet::new(), // TODO
          index_attempted: should_use_index,
        },

        // If basic proxy failed due to proxy error, and proxy mode is auto,
        // retry the main engine with enhanced proxies.
        EngineOutcome::ProxyElevationNeeded
          if meta.options.proxy == ProxyMode::Auto
            && discrete_proxy == EngineScrapeProxy::Basic =>
        {
          match main_engine
            .scrape(&meta, EngineScrapeProxy::Enhanced)
            .await?
          {
            EngineOutcome::Scraped(result) => EngineRun {
              engine: main_engine,
              result,
              unsupported_features: HashSet::new(), // TODO
              index_attempted: should_use_index,
            },
            EngineOutcome::ProxyElevationNeeded => {
              return Err(ScrapeURLError::ReliableRetrievalError(meta.options.proxy));
            }
            EngineOutcome::IndexMiss => unreachable!(),
          }
        }
        EngineOutcome::ProxyElevationNeeded => {
          return Err(ScrapeURLError::ReliableRetrievalError(meta.options.proxy));
        }
        EngineOutcome::IndexMiss => unreachable!(),
      }
    }
  };

  Span::current()
    .record("engine.winner", run.engine.get_name())
    .record(
      "engine.unsupported_features",
      run
        .unsupported_features
        .iter()
        .map(|x| x.to_string())
        .collect::<Vec<String>>()
        .join(","),
    );

  let cached_at = run.result.cached_at;
  let mut document = parsers::parse_engine_result(&meta, run.result).await?;
  if run.index_attempted {
    if let Some(cached_at) = cached_at {
      document.metadata.cache_state = DocumentMetadataCacheState::Hit;
      document.metadata.cached_at = Some(cached_at);
    } else {
      document.metadata.cache_state = DocumentMetadataCacheState::Miss;
    }
  }

  if !run.unsupported_features.is_empty() {
    document.append_warning(format!(
      "The engine used does not support the following features: {} -- your scrape may be partial.",
      run
        .unsupported_features
        .iter()
        .map(|x| x.to_string())
        .collect::<Vec<String>>()
        .join(", ")
    ));
  }

  let document = execute_tranformers(&meta, document).await?;

  Span::current()
    .record("engine.final_status_code", document.metadata.status_code)
    .record("engine.final_url", document.metadata.url.as_str())
    .record("engine.content_type", &document.metadata.content_type)
    .record(
      "engine.proxy_used",
      document.metadata.proxy_used.to_string(),
    )
    .record(
      "engine.cache_state",
      document.metadata.cache_state.to_string(),
    );

  // log metrics

  // set span attribs
  Span::current().record("scrape.success", true).record(
    "scrape.index_hit",
    document.metadata.cache_state == DocumentMetadataCacheState::Hit,
  );

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

  let options: ScrapeOptions = serde_json::from_value(serde_json::Value::Object(options))
    .map_err(ScrapeURLError::from)
    .map_err(napi_error)?;
  let internal_options: InternalOptions =
    serde_json::from_value(serde_json::Value::Object(internal_options))
      .map_err(ScrapeURLError::from)
      .map_err(napi_error)?;
  let url = Url::parse(&url)
    .map_err(|_| ScrapeURLError::InvalidURLError)
    .map_err(napi_error)?;

  let result = _scrape_url(Meta::new(id, url, team_id, options, internal_options)).await;

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
