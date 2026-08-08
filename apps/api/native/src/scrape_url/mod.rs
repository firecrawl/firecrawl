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
  options::{InternalOptions, ProxyMode, ScrapeOptions},
};

use self::meta::Meta;

pub(self) mod document;
pub(self) mod engines;
pub(self) mod error;
pub(self) mod feature_flags;
pub(self) mod formats;
pub(self) mod meta;
pub(self) mod options;
pub(self) mod parsers;
pub(self) mod rewrite_url;
pub(self) mod robots;

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

    if !index_attempted {
      Ok(None)
    } else {
      let result = EngineKind::Index.scrape(&meta, discrete_proxy).await;
      match result {
        Ok(result) => Ok(Some(EngineRun {
          engine: EngineKind::Index,
          result,
          unsupported_features: HashSet::new(), // TODO
          index_attempted: true,
        })),
        Err(ScrapeURLError::IndexMissError) => Ok(None),
        Err(e) => Err(e),
      }
    }
  }?;

  let run = match index_run {
    Some(index_run) => Ok(index_run),
    None if meta.options.lockdown => Err(ScrapeURLError::LockdownMissError),
    None if meta.internal_options.agent_index_only => Err(ScrapeURLError::AgentIndexOnlyError),
    None => {
      match engines::MAIN_ENGINE.scrape(&meta, discrete_proxy).await {
        Ok(result) => Ok(EngineRun {
          engine: *engines::MAIN_ENGINE,
          result,
          unsupported_features: HashSet::new(), // TODO
          index_attempted: should_use_index,
        }),

        // If basic proxy failed due to proxy error, and proxy mode is auto,
        // retry the main engine with enhanced proxies.
        Err(ScrapeURLError::ReliableRetrievalError)
          if meta.options.proxy == ProxyMode::Auto
            && discrete_proxy == EngineScrapeProxy::Basic =>
        {
          engines::MAIN_ENGINE
            .scrape(&meta, EngineScrapeProxy::Enhanced)
            .await
            .map(|result| EngineRun {
              engine: *engines::MAIN_ENGINE,
              result,
              unsupported_features: HashSet::new(), // TODO
              index_attempted: should_use_index,
            })
        }

        Err(x) => Err(x),
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
      document.metadata.cached_at = Some(cached_at.to_rfc3339());
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

// wrapper that lets us avoid exposing Meta in JS-land
#[napi]
pub async fn scrape_url(
  id: String,
  url: String,
  team_id: String,
  // TODO: figure out ScrapeOptions, InternalOptions from NAPI
  // options: ScrapeOptions,
  // internal_options: InternalOptions,
  // cost_tracking:
) -> Result<serde_json::Map<String, serde_json::Value>, napi::Error> {
  match _scrape_url(Meta::new(
    id,
    Url::parse(&url).unwrap(), // TODO: Better handling
    team_id,
    ScrapeOptions::default(),
    InternalOptions::default(),
  ))
  .await
  {
    Ok(x) => Ok(match serde_json::to_value(x).unwrap() {
      serde_json::Value::Object(x) => x,
      _ => unreachable!(),
    }),
    Err(e) => Err(napi::Error::new(
      napi::Status::GenericFailure,
      format!("{:?}", e),
    )),
  }
}
