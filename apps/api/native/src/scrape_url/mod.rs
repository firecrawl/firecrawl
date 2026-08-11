use std::collections::HashSet;

// use napi::bindgen_prelude::*;
use napi_derive::napi;
use tracing::{Span, field::Empty, instrument};
use url::Url;

use self::{
  document::{Document, DocumentMetadataCacheState},
  engines::{EngineKind, EngineScrapeProxy, EngineScrapeResult, should_use_index},
  error::ScrapeURLError,
  feature_flags::FeatureFlags,
  meta::Meta,
  options::{InternalOptions, ProxyMode, ScrapeOptions},
};
use crate::scrape_url::engines::{EngineSignal, get_main_engine};

mod actions;
mod document;
mod engines;
mod error;
mod feature_flags;
mod formats;
mod kinded;
mod meta;
mod options;
mod parsers;
mod rewrite_url;
mod robots;

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
    engine.winner = Empty,
    engine.unsupported_features = Empty,
    engine.final_status_code = Empty,
  ),
  skip(meta)
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
    let index_attempted =
      meta.options.lockdown || meta.internal_options.agent_index_only || should_use_index;

    if index_attempted && let Some(index) = EngineKind::index().await {
      let result = index.scrape(&meta, discrete_proxy).await;
      match result {
        Ok(result) => Ok(Some(EngineRun {
          engine: index,
          result,
          unsupported_features: HashSet::new(), // TODO
          index_attempted: true,
        })),
        Err(EngineSignal::IndexMiss) => Ok(None),
        Err(EngineSignal::FatalError(e)) => Err(e),
        Err(EngineSignal::EngineError(_)) => unimplemented!(),

        // TODO: this pattern is disgusting and proof that the index and an engine should be separate primitives
        Err(EngineSignal::ProxyElevationNeeded) => unreachable!(),
      }
    } else {
      Ok(None)
    }
  }?;

  let run = match index_run {
    Some(index_run) => Ok(index_run),
    None if meta.options.lockdown => Err(ScrapeURLError::LockdownMissError),
    None if meta.internal_options.agent_index_only => Err(ScrapeURLError::AgentIndexOnlyError),
    None => {
      let main_engine = get_main_engine().await;
      match get_main_engine().await.scrape(&meta, discrete_proxy).await {
        Ok(result) => Ok(EngineRun {
          engine: main_engine,
          result,
          unsupported_features: HashSet::new(), // TODO
          index_attempted: should_use_index,
        }),

        // If basic proxy failed due to proxy error, and proxy mode is auto,
        // retry the main engine with enhanced proxies.
        Err(EngineSignal::ProxyElevationNeeded)
          if meta.options.proxy == ProxyMode::Auto
            && discrete_proxy == EngineScrapeProxy::Basic =>
        {
          main_engine
            .scrape(&meta, EngineScrapeProxy::Enhanced)
            .await
            .map(|result| EngineRun {
              engine: main_engine,
              result,
              unsupported_features: HashSet::new(), // TODO
              index_attempted: should_use_index,
            })
            .map_err(|e| match e {
              EngineSignal::FatalError(e) => e,
              EngineSignal::EngineError(_) => unimplemented!(),
              EngineSignal::ProxyElevationNeeded => {
                ScrapeURLError::ReliableRetrievalError(meta.options.proxy)
              }
              EngineSignal::IndexMiss => unreachable!(),
            })
        }
        Err(EngineSignal::ProxyElevationNeeded) => {
          Err(ScrapeURLError::ReliableRetrievalError(meta.options.proxy))
        }
        Err(EngineSignal::FatalError(e)) => Err(e),
        Err(EngineSignal::EngineError(_)) => unimplemented!(),
        Err(EngineSignal::IndexMiss) => unreachable!(),
      }
    }
  }?;

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

  // execute transformers

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

  let options: ScrapeOptions = serde_json::from_value(serde_json::Value::Object(options)).unwrap();
  let internal_options: InternalOptions =
    serde_json::from_value(serde_json::Value::Object(internal_options)).unwrap();

  match _scrape_url(Meta::new(
    id,
    Url::parse(&url).unwrap(), // TODO: Better handling
    team_id,
    options,
    internal_options,
  ))
  .await
  {
    Ok(x) => Ok(match serde_json::to_value(x).unwrap() {
      serde_json::Value::Object(x) => x,
      _ => unreachable!(),
    }),
    // TODO: better transportable errors
    Err(e) => Err(napi::Error::new(
      napi::Status::GenericFailure,
      format!("{:?}", e),
    )),
  }
}
