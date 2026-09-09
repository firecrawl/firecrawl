use std::{net::IpAddr, time::Duration};

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use tracing::instrument;
use url::Url;

use self::{
  cache::{IndexCache, IndexCacheResult},
  db::{IndexDb, IndexEntry},
  gcs::IndexGcs,
};
use super::{
  error::ScrapeURLError,
  feature_flags::FeatureFlag,
  formats::FormatKind,
  meta::Meta,
  raw_page::{RawPageContent, RawPageResult, ScrapeProxy},
};

pub use self::gcs::IndexPDFMetadata;

mod cache;
mod db;
mod gcs;

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
    .and_then(|mut x| x.next_back()) // x.last() but more performant
    .map(|x| x.to_string());
  if let Some(last_seg) = last_seg
    && (last_seg == "index.html"
      || last_seg == "index.php"
      || last_seg == "index.html"
      || last_seg == "index.shtml"
      || last_seg == "index.xml"
      || last_seg.is_empty())
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

enum IndexEntrySource<'a> {
  Cache(&'a IndexCache),
  Db,
}

impl<'a> PartialEq for IndexEntrySource<'a> {
  fn eq(&self, other: &Self) -> bool {
    match self {
      IndexEntrySource::Cache(_) => matches!(other, IndexEntrySource::Cache(_)),
      IndexEntrySource::Db => matches!(other, IndexEntrySource::Db),
    }
  }
}

impl<'a> Eq for IndexEntrySource<'a> {}

#[derive(Debug)]
struct IndexEntryVariant {
  pub url_hash: Vec<u8>,
  pub is_mobile: bool,
  pub block_ads: bool,
  pub is_stealth: bool,

  /// `None` for the default `us-generic` country, which the index treats as
  /// "no country specified" (stored/queried as NULL) -- matches the TS pipeline
  /// which sends `location?.country ?? null`.
  pub location_country: Option<String>,

  /// The sanity of the variant depends on this being
  /// deduplicated and sorted ascending.
  /// Do not mess with it manually!!! - Mogery
  pub location_languages: Vec<String>,
}

impl IndexEntryVariant {
  pub fn new(url_hash: Vec<u8>, meta: &Meta, proxy: ScrapeProxy) -> Self {
    let mut location_languages: Vec<String> = meta.options.location.languages.clone();
    location_languages.dedup();
    location_languages.sort();

    Self {
      url_hash,
      is_mobile: meta.options.mobile,
      block_ads: meta.options.block_ads,
      is_stealth: proxy == ScrapeProxy::Enhanced,
      location_country: meta.options.location.country.to_index_value(),
      location_languages,
    }
  }
}

#[derive(Debug)]
struct IndexEntryFilter {
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
      max_age: max_age,
      min_age: meta.options.min_age,
      needs_screenshot: meta.feature_flags.contains(&FeatureFlag::Screenshot),
      needs_screenshot_fullscreen: meta
        .feature_flags
        .contains(&FeatureFlag::ScreenshotFullScreen),
      wait_time_ms: meta.options.effective_wait_for(),
      now: Utc::now(),
    }
  }
}

pub struct Index {
  db: IndexDb,
  gcs: IndexGcs,
  cache: Option<IndexCache>,
}

impl Index {
  pub const NAME: &'static str = "index";

  pub async fn get() -> Result<Option<Self>, ScrapeURLError> {
    let (Some(gcs), Some(db)) = (IndexGcs::get().await?, IndexDb::get().await?) else {
      return Ok(None);
    };

    Ok(Some(Self {
      db,
      gcs,
      cache: IndexCache::get().await.ok().flatten(),
    }))
  }

  #[instrument(name = "Index::lookup", skip(meta, self), err)]
  pub async fn lookup(
    &self,
    meta: &Meta,
    proxy: ScrapeProxy,
  ) -> Result<Option<RawPageResult>, ScrapeURLError> {
    let normalized_url = normalize_url_for_index(meta.get_url().clone());

    // TODO: fix index to support int8 = i64 to uncap max_age from 30-something days or so
    let (max_age, _max_age_source): (i32, MaxAgeSource) = {
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
          let query_max_age = async {
            if let Some(index_cache) = &self.cache
              && let Ok(Some(max_age)) = index_cache.get_max_age(domain_hash).await
            {
              (max_age, MaxAgeSource::DynamicCached)
            } else if let Ok(Some(max_age)) = self.db.get_max_age(domain_hash).await {
              if let Some(index_cache) = &self.cache {
                let _ = index_cache.set_max_age(domain_hash, max_age).await;
              }
              (max_age, MaxAgeSource::DynamicDb)
            } else {
              (DEFAULT_MAX_AGE, MaxAgeSource::Default)
            }
          };

          tokio::select! {
            (max_age, max_age_source) = query_max_age => {
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

    let variant = IndexEntryVariant::new(url_hash, meta, proxy);
    let filter = IndexEntryFilter::new(max_age, meta);

    let cache_lookup = match &self.cache {
      Some(index_cache) => Some((index_cache, index_cache.get_entries(&variant, &filter).await)),
      None => None,
    };

    let (entries, source) = match cache_lookup {
      Some((index_cache, Ok(IndexCacheResult::PositiveHit(entries)))) => {
        (Some(entries), IndexEntrySource::Cache(index_cache))
      }
      Some((index_cache, Ok(IndexCacheResult::NegativeHit))) => {
        (None, IndexEntrySource::Cache(index_cache))
      }
      Some((index_cache, Ok(IndexCacheResult::Miss))) => {
        let entries = self.db.get_entries(&variant, &filter).await?;
        (
          if !entries.is_empty() {
            if meta.options.min_age.is_none() {
              let _ = index_cache.upsert_entries(&variant, &entries).await;
            }

            Some(entries)
          } else {
            if meta.options.min_age.is_none() {
              // TODO: this is suboptimal as it can overwrite a more broader negative hit signal
              let _ = index_cache
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
        )
      }
      Some((_, Err(_))) | None => {
        let entries = self.db.get_entries(&variant, &filter).await?;
        (
          if entries.is_empty() {
            None
          } else {
            Some(entries)
          },
          IndexEntrySource::Db,
        )
      }
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

    let Some(selected_row) = selected_row else {
      return Ok(None);
    };

    let doc = self.gcs.get_document(selected_row.id).await?;

    if let Some(doc) = doc {
      let normalized_pdf_metadata = doc.pdf_metadata.or_else(|| {
        doc.num_pages.map(|x| IndexPDFMetadata {
          num_pages: x,
          total_pages: None,
          title: None, // TODO: is doc.title a thing?
        })
      });

      // If parsers.pdf().max_pages is defined, and the resulting document has a
      // num_pages value (therefore it's a PDF), enforce the max_pages via
      // simulating an index miss. I hate this - Mogery
      if let Some(num_pages) = normalized_pdf_metadata.as_ref().map(|x| x.num_pages)
        && let Some(pdf_parser) = meta.options.parsers.pdf()
        && let Some(max_pages) = pdf_parser.max_pages
        && num_pages > max_pages
      {
        return Ok(None);
      }

      Ok(Some(RawPageResult {
        url: doc.url,
        content: RawPageContent::IndexFakeHTML(doc.html, normalized_pdf_metadata),
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
      }))
    } else {
      if let IndexEntrySource::Cache(index_cache) = source {
        // drop poisoned cache
        let _ = index_cache.delete_entry(&variant, selected_row.id).await;
      }
      Ok(None)
    }
  }
}

pub fn should_use_index(meta: &Meta) -> bool {
  let has_custom_screenshot_settings = if let Some(screenshot) = meta.options.formats.screenshot() {
    screenshot.viewport.is_some() || screenshot.quality.is_some()
  } else {
    false
  };

  let has_custom_pdf_settings = if let Some(pdf) = meta.options.parsers.pdf() {
    pdf.blocks || pdf.pages || pdf.page_markers
  } else {
    false
  };

  !meta.options.formats.contains(FormatKind::ChangeTracking)
    && !meta.options.formats.contains(FormatKind::Branding)
    && !has_custom_pdf_settings
    && !has_custom_screenshot_settings
    && meta.options.max_age != Some(0)
    && meta.options.headers.is_empty()
    && meta.options.actions.is_empty()
    && meta.options.profile.is_none()
}
