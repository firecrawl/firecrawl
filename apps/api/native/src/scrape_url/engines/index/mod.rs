use std::{net::IpAddr, time::Duration};

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use url::Url;

use crate::scrape_url::engines::{EngineScrapeContent, index::gcs::IndexGcs};

use self::{
  cache::{IndexCache, IndexCacheResult},
  db::{IndexDb, IndexEntry},
};
use super::super::{
  error::ScrapeURLError,
  feature_flags::{ConstFeatureFlags, FeatureFlag},
  meta::Meta,
};
use super::{Engine, EngineScrapeProxy, EngineScrapeResult};

pub(self) mod cache;
pub(self) mod db;
pub(self) mod gcs;

const DEFAULT_MAX_AGE: i32 = 2 * 24 * 60 * 60 * 1000;

fn normalize_url_for_index(mut url: Url) -> Url {
  if url
    .fragment()
    .map(|x| x.len() <= 2 || (!x.starts_with("#/") && !x.starts_with("#!/")))
    .unwrap_or(false)
  {
    url.set_fragment(None);
  }

  url.set_scheme("https").unwrap();

  if url.port().map(|x| x == 80 || x == 443).unwrap_or(false) {
    url.set_port(None).unwrap();
  }

  if let Some(host) = url.host_str().map(|x| x.to_string())
    && host.starts_with("www.")
  {
    url.set_host(Some(&host[4..])).unwrap();
  }

  let last_seg: Option<String> = url
    .path_segments()
    .and_then(|x| x.last())
    .map(|x| x.to_string());
  if let Some(last_seg) = last_seg
    && (last_seg == "index.html"
      || last_seg == "index.php"
      || last_seg == "index.html"
      || last_seg == "index.shtml"
      || last_seg == "index.xml"
      || last_seg == "")
  {
    url.path_segments_mut().unwrap().pop();
  }

  url
}

fn hash_url(url: impl AsRef<str>) -> Vec<u8> {
  Sha256::digest(url.as_ref().as_bytes()).to_vec()
}

fn generate_domain_splits(hostname: impl AsRef<str>) -> Vec<String> {
  let host = hostname.as_ref().to_ascii_lowercase();

  let ip_trimmed = host.trim_start_matches('[').trim_end_matches(']');
  if ip_trimmed.parse::<IpAddr>().is_ok() {
    vec![ip_trimmed.to_string()]
  } else if let Some(domain) = psl::domain_str(&host) {
    let subdomains: Vec<&str> = host
      .strip_suffix(domain)
      .and_then(|s| s.strip_suffix('.'))
      .unwrap_or("")
      .split('.')
      .filter(|s| !s.is_empty())
      .collect();

    if subdomains.as_slice() == ["www"] {
      vec![domain.to_string()]
    } else {
      (0..=subdomains.len())
        .rev()
        .map(|i| {
          let mut parts = Vec::with_capacity(subdomains.len() - i + 1);
          parts.extend_from_slice(&subdomains[i..]);
          parts.push(domain);
          parts.join(".")
        })
        .collect()
    }
  } else {
    Vec::with_capacity(0)
  }
}

enum MaxAgeSource {
  Explicit,
  DynamicCached,
  DynamicDb,
  Default,
}

enum IndexEntrySource {
  Cache(IndexCache),
  Db,
}

impl PartialEq for IndexEntrySource {
  fn eq(&self, other: &Self) -> bool {
    match self {
      IndexEntrySource::Cache(_) => matches!(other, IndexEntrySource::Cache(_)),
      IndexEntrySource::Db => matches!(other, IndexEntrySource::Db),
    }
  }
}

impl Eq for IndexEntrySource {}

pub(self) struct IndexEntryVariant {
  pub url_hash: Vec<u8>,
  pub is_mobile: bool,
  pub block_ads: bool,
  pub is_stealth: bool,
  pub location_country: Option<String>,

  /// The sanity of the variant depends on this being
  /// deduplicated and sorted ascending.
  /// Do not mess with it manually!!! - Mogery
  pub location_languages: Vec<String>,
}

impl IndexEntryVariant {
  pub fn new(url_hash: Vec<u8>, meta: &Meta, proxy: EngineScrapeProxy) -> Self {
    let mut location_languages: Vec<String> = Vec::with_capacity(0); // TODO: meta.options.location.languages.clone();
    location_languages.dedup();
    location_languages.sort();

    Self {
      url_hash,
      is_mobile: meta.options.mobile,
      block_ads: meta.options.block_ads,
      is_stealth: proxy == EngineScrapeProxy::Enhanced,
      location_country: None, // TODO: meta.options.location.country
      location_languages,
    }
  }
}

pub(self) struct IndexEntryFilter {
  pub max_age: i32,
  pub min_age: Option<i32>,
  pub needs_screenshot: bool,
  pub needs_screenshot_fullscreen: bool,
  pub wait_time_ms: i32,
  pub now: DateTime<Utc>,
}

impl IndexEntryFilter {
  pub fn new(max_age: i32, meta: &Meta) -> Self {
    Self {
      max_age,
      min_age: meta.options.min_age,
      needs_screenshot: meta.feature_flags.contains(&FeatureFlag::Screenshot),
      needs_screenshot_fullscreen: meta
        .feature_flags
        .contains(&FeatureFlag::ScreenshotFullScreen),
      wait_time_ms: meta.options.wait_for as i32,
      now: Utc::now(),
    }
  }
}

async fn query_max_age(domain_hash: &[u8]) -> (i32, MaxAgeSource) {
  // check cache first
  if let Some(index_cache) = IndexCache::get().await
    && let Some(max_age) = index_cache.get_max_age(&domain_hash).await
  {
    return (max_age, MaxAgeSource::DynamicCached);
  }

  if let Some(index_db) = IndexDb::get().await
    && let Some(max_age) = index_db.get_max_age(&domain_hash).await
  {
    if let Some(index_cache) = IndexCache::get().await {
      index_cache.set_max_age(&domain_hash, max_age).await;
    }

    return (max_age, MaxAgeSource::DynamicDb);
  }

  (DEFAULT_MAX_AGE, MaxAgeSource::Default)
}

pub struct IndexEngine;

impl Engine for IndexEngine {
  const NAME: &'static str = "index";
  const IS_SPECIAL: bool = false;
  const FEATURES: ConstFeatureFlags = ConstFeatureFlags::new(&[
    FeatureFlag::WaitFor,
    FeatureFlag::Screenshot,
    FeatureFlag::ScreenshotFullScreen,
    FeatureFlag::Mobile,
    FeatureFlag::Location,
    FeatureFlag::DisableAdblock,
  ]);

  async fn scrape(
    meta: &Meta,
    proxy: EngineScrapeProxy,
  ) -> Result<EngineScrapeResult, ScrapeURLError> {
    let normalized_url = normalize_url_for_index(meta.get_url().clone());

    let (max_age, max_age_source): (i32, MaxAgeSource) = {
      if let Some(max_age) = meta.options.max_age {
        (max_age, MaxAgeSource::Explicit)
      } else {
        let domain_splits_hash: Vec<Vec<u8>> =
          generate_domain_splits(normalized_url.host_str().unwrap())
            .into_iter()
            .map(hash_url)
            .collect();

        if let Some(domain_hash) = domain_splits_hash.last()
          && std::env::var("USE_DB_AUTHENTICATION").ok() == Some("true".to_string())
        {
          tokio::select! {
            (max_age, max_age_source) = query_max_age(&domain_hash) => {
              (max_age, max_age_source)
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(200)) => {
              // timeout branch
              (DEFAULT_MAX_AGE, MaxAgeSource::Default)
            }
          }
        } else {
          (DEFAULT_MAX_AGE, MaxAgeSource::Default)
        }
      }
    };

    let url_hash = hash_url(&normalized_url);

    let variant = IndexEntryVariant::new(url_hash, &meta, proxy);
    let filter = IndexEntryFilter::new(max_age, &meta);

    let (entries, source) = match {
      if let Some(index_cache) = IndexCache::get().await {
        Some((
          index_cache.get_entries(&variant, &filter).await,
          index_cache,
        ))
      } else {
        None
      }
    } {
      Some((IndexCacheResult::PositiveHit(entries), index_cache)) => {
        (Some(entries), IndexEntrySource::Cache(index_cache))
      }
      Some((IndexCacheResult::NegativeHit, index_cache)) => {
        (None, IndexEntrySource::Cache(index_cache))
      }
      Some((IndexCacheResult::Miss, _)) | None => (
        if let Some(index_db) = IndexDb::get().await
          && let entries = index_db.get_entries(&variant, &filter).await
          && !entries.is_empty()
        {
          if meta.options.min_age.is_none()
            && let Some(index_cache) = IndexCache::get().await
          {
            index_cache.upsert_entries(&variant, &entries).await;
          }

          Some(entries)
        } else {
          if meta.options.min_age.is_none()
            && let Some(index_cache) = IndexCache::get().await
          {
            // TODO: this is suboptimal as it can overwrite a more broader negative hit signal
            index_cache
              .set_negative(
                &variant,
                &filter,
                Utc::now() - Duration::from_millis(filter.max_age as u64),
              )
              .await;
          }

          None
        },
        IndexEntrySource::Db,
      ),
    };

    let selected_row: Option<IndexEntry> = if let Some(entries) = entries {
      let index = {
        let newest_ok = entries
          .iter()
          .enumerate()
          .find(|(_, x)| x.status >= 200 && x.status < 300)
          .map(|(i, _)| i);
        match newest_ok {
          Some(i) if i < 3 => {
            // Graceful cache: if the page is failing intermittently,
            // but there's a 200-like result in the newest 3 entries,
            // just return the 200-like result
            i
          }
          _ => {
            // Otherwise, just pick the latest entry.
            0
          }
        }
      };

      entries.into_iter().nth(index)
    } else {
      None
    };

    if let Some(selected_row) = selected_row {
      if let Some(index_gcs) = IndexGcs::get().await {
        if let Some(doc) = index_gcs.get_document(&selected_row.id).await {
          // TODO: isCachedPdfBase64 buffoonery

          Ok(EngineScrapeResult {
            url: doc.url,
            content: EngineScrapeContent::DecodedText(doc.html),
            // json???
            status_code: doc.status_code,
            screenshot: doc.screenshot,
            actions: None,
            content_type: doc
              .content_type
              .unwrap_or_else(|| "application/octet-stream".to_string()),
            cached_at: Some(selected_row.created_at),
            proxy_used: doc.proxy_used,
            timezone: None,
            filename: None,
          })
        } else {
          if let IndexEntrySource::Cache(index_cache) = source {
            // drop poisoned cache
            index_cache.delete_entry(&variant, &selected_row.id).await;
          }
          Err(ScrapeURLError::IndexMissError)
        }
      } else {
        unreachable!()
      }
    } else {
      Err(ScrapeURLError::IndexMissError)
    }
  }
}
